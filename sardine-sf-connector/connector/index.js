/**
 * Sardine → Salesforce Connector (port 3002)
 *
 * This is the core integration layer. It:
 * 1. Registers a webhook with Sardine on startup
 * 2. Receives risk update events from Sardine
 * 3. Transforms the payload into Salesforce field format
 * 4. Upserts custom fields on the SF Account record
 * 5. Exposes a status endpoint for the demo dashboard
 *
 * In production this would be an authenticated Lambda/Cloud Function
 * with queue-backed retry, field mapping config, and audit logging.
 */

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const SARDINE_URL = "http://localhost:3001";
const SALESFORCE_URL = "http://localhost:3003";
const CONNECTOR_URL = "http://localhost:3002";

// ─── Event Log (in-memory for demo) ───────────────────────────────────────
const eventLog = [];
const MAX_LOG = 50;

function logEvent(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  console.log(`[Connector] ${type}: ${JSON.stringify(data).slice(0, 120)}`);
  return entry;
}

// ─── Field Transformer ─────────────────────────────────────────────────────
// Maps Sardine risk profile → Salesforce custom field names
// In production: driven by customer-specific field mapping config
function transformToSalesforceFields(sardineData) {
  const { riskProfile, sfAccountId } = sardineData;

  const riskLevelEmoji = {
    LOW: "🟢 LOW",
    MEDIUM: "🟡 MEDIUM",
    HIGH: "🔴 HIGH",
    CRITICAL: "🚨 CRITICAL",
  };

  const kycStatusLabel = {
    APPROVED: "✅ Approved",
    PENDING: "⏳ Pending",
    REJECTED: "❌ Rejected",
    NOT_STARTED: "— Not Started",
  };

  return {
    sfAccountId,
    fields: {
      // Core risk indicators
      Sardine_Risk_Level__c: riskLevelEmoji[riskProfile.overallRiskLevel] || riskProfile.overallRiskLevel,
      Sardine_Fraud_Score__c: riskProfile.fraudScore,
      Sardine_Last_Updated__c: riskProfile.lastChecked,

      // KYC / Identity
      Sardine_KYC_Status__c: kycStatusLabel[riskProfile.kycStatus] || riskProfile.kycStatus,
      Sardine_KYC_Level__c: riskProfile.kycLevel,

      // AML
      Sardine_AML_Risk__c: riskLevelEmoji[riskProfile.amlRiskLevel] || riskProfile.amlRiskLevel,

      // Device signals
      Sardine_Device_Risk__c: riskLevelEmoji[riskProfile.deviceRisk.level] || riskProfile.deviceRisk.level,
      Sardine_Device_Signals__c: riskProfile.deviceRisk.signals.join(", ") || "None",

      // Behavior
      Sardine_Behavior_Signals__c: riskProfile.behaviorRisk.signals.join(", ") || "None",

      // Case management
      Sardine_Case_Status__c: riskProfile.caseStatus,
      Sardine_Case_ID__c: riskProfile.caseId || "",

      // Checkpoint summary
      Sardine_Checkpoints_Passed__c: riskProfile.checkpointsPassed.join(", ") || "None",
      Sardine_Checkpoints_Failed__c: riskProfile.checkpointsFailed.join(", ") || "None",
    },
  };
}

// ─── Salesforce Upsert ─────────────────────────────────────────────────────
async function upsertToSalesforce(sfAccountId, fields) {
  try {
    const res = await axios.patch(
      `${SALESFORCE_URL}/services/data/v58.0/sobjects/Account/${sfAccountId}`,
      fields,
      { headers: { "Content-Type": "application/json", Authorization: "Bearer mock-sf-token" } }
    );
    logEvent("sf_upsert_success", { sfAccountId, status: res.status, fieldCount: Object.keys(fields).length });
    return { success: true };
  } catch (err) {
    logEvent("sf_upsert_error", { sfAccountId, error: err.message });
    return { success: false, error: err.message };
  }
}

// ─── Webhook Receiver ──────────────────────────────────────────────────────
app.post("/webhook/sardine", async (req, res) => {
  const event = req.body;

  logEvent("webhook_received", {
    eventId: event.id,
    eventType: event.type,
    customerId: event.data?.customerId,
    sfAccountId: event.data?.sfAccountId,
    riskLevel: event.data?.riskProfile?.overallRiskLevel,
    fraudScore: event.data?.riskProfile?.fraudScore,
  });

  if (event.type === "customer.risk_updated") {
    const { sfAccountId, fields } = transformToSalesforceFields(event.data);
    await upsertToSalesforce(sfAccountId, fields);
  }

  // Acknowledge immediately (async processing in prod would use a queue)
  res.status(200).json({ received: true });
});

// ─── Status / Dashboard API ────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    service: "sardine-sf-connector",
    status: "running",
    sardineEndpoint: SARDINE_URL,
    salesforceEndpoint: SALESFORCE_URL,
    webhookEndpoint: `${CONNECTOR_URL}/webhook/sardine`,
    eventLog: eventLog.slice(0, 20),
  });
});

app.get("/events", (req, res) => {
  res.json({ events: eventLog });
});

// ─── Startup: Register webhook with Sardine + initial sync ────────────────
async function startup() {
  // Wait for Sardine to be ready
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // Register webhook
    await axios.post(`${SARDINE_URL}/v1/webhooks/register`, {
      url: `${CONNECTOR_URL}/webhook/sardine`,
      events: ["customer.risk_updated", "customer.kyc_completed", "customer.case_created"],
    });
    logEvent("startup", { message: "Webhook registered with Sardine" });

    // Initial full sync: pull all customers and push to SF
    const { data } = await axios.get(`${SARDINE_URL}/v1/customers`);
    logEvent("startup", { message: `Initial sync: ${data.total} customers` });

    for (const customer of data.customers) {
      const { sfAccountId, fields } = transformToSalesforceFields({
        sfAccountId: customer.sfAccountId,
        riskProfile: customer.riskProfile,
      });
      await upsertToSalesforce(sfAccountId, fields);
    }

    logEvent("startup", { message: "Initial sync complete — connector ready" });
  } catch (err) {
    logEvent("startup_error", { message: err.message });
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = 3002; // Fixed internal port — do not use process.env.PORT
app.listen(PORT, () => {
  console.log(`[Connector] Running on http://localhost:${PORT}`);
  startup();
});
