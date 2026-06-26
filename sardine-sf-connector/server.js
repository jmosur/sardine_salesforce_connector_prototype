/**
 * Sardine → Salesforce Connector — Single-file Railway deployment
 *
 * All three services in one file, each on its own port:
 *   Sardine mock API  → internal port 3001
 *   Connector         → internal port 3002
 *   Salesforce UI     → process.env.PORT (Railway's public port)
 */

const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

// ════════════════════════════════════════════════════════════
// PORTS
// ════════════════════════════════════════════════════════════
const SF_PORT      = process.env.PORT || 3003;
const SARDINE_PORT = 3001;
const CONN_PORT    = 3002;

const SARDINE_URL   = `http://localhost:${SARDINE_PORT}`;
const CONNECTOR_URL = `http://localhost:${CONN_PORT}`;
const SF_URL        = `http://localhost:${SF_PORT}`;

// ════════════════════════════════════════════════════════════
// 1. MOCK SARDINE API
// ════════════════════════════════════════════════════════════
const sardineApp = express();
sardineApp.use(express.json());

const customers = {
  "acct-001": {
    id: "acct-001", sfAccountId: "0015g00000XkYzAAA1",
    name: "Acme Corp", email: "finance@acme.com",
    sardineCustomerId: "sardine-cust-abc123",
    riskProfile: {
      overallRiskLevel: "HIGH", fraudScore: 82,
      kycStatus: "APPROVED", kycLevel: "ENHANCED", amlRiskLevel: "MEDIUM",
      deviceRisk: { level: "HIGH", signals: ["vpn_detected", "velocity_abuse", "emulator_suspected"], fingerprint: "fp-d8a7c3b2" },
      behaviorRisk: { level: "MEDIUM", signals: ["unusual_login_time", "new_device"] },
      caseStatus: "UNDER_REVIEW", caseId: "case-7821",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified"],
      checkpointsFailed: ["device_trust"],
    },
  },
  "acct-002": {
    id: "acct-002", sfAccountId: "0015g00000XkYzAAA2",
    name: "Globex Financial", email: "compliance@globex.com",
    sardineCustomerId: "sardine-cust-def456",
    riskProfile: {
      overallRiskLevel: "LOW", fraudScore: 12,
      kycStatus: "APPROVED", kycLevel: "STANDARD", amlRiskLevel: "LOW",
      deviceRisk: { level: "LOW", signals: [], fingerprint: "fp-a1b2c3d4" },
      behaviorRisk: { level: "LOW", signals: [] },
      caseStatus: "CLEARED", caseId: null,
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified", "device_trust", "aml_screening"],
      checkpointsFailed: [],
    },
  },
  "acct-003": {
    id: "acct-003", sfAccountId: "0015g00000XkYzAAA3",
    name: "Initech Payments", email: "ops@initech.io",
    sardineCustomerId: "sardine-cust-ghi789",
    riskProfile: {
      overallRiskLevel: "MEDIUM", fraudScore: 47,
      kycStatus: "PENDING", kycLevel: "STANDARD", amlRiskLevel: "LOW",
      deviceRisk: { level: "LOW", signals: ["tor_exit_node"], fingerprint: "fp-e5f6g7h8" },
      behaviorRisk: { level: "MEDIUM", signals: ["high_transaction_velocity"] },
      caseStatus: "OPEN", caseId: "case-7955",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["email_verified"],
      checkpointsFailed: ["kyc_basic"],
    },
  },
};

let webhookEndpoints = [];

sardineApp.get("/v1/customers", (req, res) => {
  res.json({ customers: Object.values(customers), total: Object.keys(customers).length });
});

sardineApp.get("/v1/customers/:id", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  c.riskProfile.lastChecked = new Date().toISOString();
  res.json(c);
});

sardineApp.post("/v1/webhooks/register", (req, res) => {
  const { url, events } = req.body;
  const id = uuidv4();
  webhookEndpoints.push({ id, url, events });
  console.log(`[Sardine] Webhook registered: ${url}`);
  res.json({ id, message: "Webhook registered successfully" });
});

sardineApp.post("/v1/customers/:id/simulate", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  applyScenario(c, req.body.scenario || "escalate");
  fireWebhooks(c, "customer.risk_updated");
  res.json({ message: `Scenario applied`, riskProfile: c.riskProfile });
});

function applyScenario(customer, scenario) {
  const p = customer.riskProfile;
  switch (scenario) {
    case "escalate":
      p.overallRiskLevel = "HIGH";
      p.fraudScore = Math.min(99, p.fraudScore + 30);
      p.caseStatus = "UNDER_REVIEW";
      p.caseId = p.caseId || `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      p.deviceRisk.signals = ["new_device_high_risk", "velocity_abuse"];
      p.deviceRisk.level = "HIGH";
      break;
    case "clear":
      p.overallRiskLevel = "LOW";
      p.fraudScore = Math.max(1, p.fraudScore - 40);
      p.caseStatus = "CLEARED"; p.amlRiskLevel = "LOW";
      p.deviceRisk.signals = []; p.deviceRisk.level = "LOW";
      p.behaviorRisk.signals = []; p.checkpointsFailed = [];
      p.kycStatus = "APPROVED";
      break;
    case "kyc_fail":
      p.kycStatus = "REJECTED"; p.overallRiskLevel = "HIGH";
      p.fraudScore = Math.min(99, p.fraudScore + 20);
      p.checkpointsFailed = ["kyc_enhanced"];
      break;
    case "aml_flag":
      p.amlRiskLevel = "HIGH"; p.overallRiskLevel = "HIGH";
      p.caseStatus = "OPEN";
      p.caseId = `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      break;
  }
  p.lastChecked = new Date().toISOString();
}

async function fireWebhooks(customer, eventType) {
  const payload = {
    id: uuidv4(), type: eventType, created: new Date().toISOString(),
    data: { customerId: customer.sardineCustomerId, sfAccountId: customer.sfAccountId, internalId: customer.id, riskProfile: customer.riskProfile },
  };
  for (const ep of webhookEndpoints) {
    if (ep.events.includes(eventType) || ep.events.includes("*")) {
      try {
        await axios.post(ep.url, payload, { timeout: 3000 });
        console.log(`[Sardine] Webhook fired → ${ep.url}`);
      } catch (e) {
        console.log(`[Sardine] Webhook failed: ${e.message}`);
      }
    }
  }
}

// Auto-simulation every 30s
let simIndex = 0;
const simScenarios = ["escalate", "clear", "kyc_fail", "aml_flag", "clear"];
const simCustomerIds = Object.keys(customers);
setInterval(() => {
  const c = customers[simCustomerIds[simIndex % simCustomerIds.length]];
  const s = simScenarios[simIndex % simScenarios.length];
  console.log(`[Sardine] Auto-sim: ${c.name} → ${s}`);
  applyScenario(c, s);
  fireWebhooks(c, "customer.risk_updated");
  simIndex++;
}, 30000);

sardineApp.listen(SARDINE_PORT, () => console.log(`[Sardine] Running on port ${SARDINE_PORT}`));

// ════════════════════════════════════════════════════════════
// 2. CONNECTOR
// ════════════════════════════════════════════════════════════
const connApp = express();
connApp.use(express.json());

const eventLog = [];
function logEvent(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  eventLog.unshift(entry);
  if (eventLog.length > 50) eventLog.pop();
  console.log(`[Connector] ${type}: ${JSON.stringify(data).slice(0, 120)}`);
  return entry;
}

function transformFields(sardineData) {
  const { riskProfile, sfAccountId } = sardineData;
  const riskEmoji = { LOW: "🟢 LOW", MEDIUM: "🟡 MEDIUM", HIGH: "🔴 HIGH", CRITICAL: "🚨 CRITICAL" };
  const kycLabel  = { APPROVED: "✅ Approved", PENDING: "⏳ Pending", REJECTED: "❌ Rejected", NOT_STARTED: "— Not Started" };
  return {
    sfAccountId,
    fields: {
      Sardine_Risk_Level__c:        riskEmoji[riskProfile.overallRiskLevel] || riskProfile.overallRiskLevel,
      Sardine_Fraud_Score__c:       riskProfile.fraudScore,
      Sardine_Last_Updated__c:      riskProfile.lastChecked,
      Sardine_KYC_Status__c:        kycLabel[riskProfile.kycStatus] || riskProfile.kycStatus,
      Sardine_KYC_Level__c:         riskProfile.kycLevel,
      Sardine_AML_Risk__c:          riskEmoji[riskProfile.amlRiskLevel] || riskProfile.amlRiskLevel,
      Sardine_Device_Risk__c:       riskEmoji[riskProfile.deviceRisk.level] || riskProfile.deviceRisk.level,
      Sardine_Device_Signals__c:    riskProfile.deviceRisk.signals.join(", ") || "None",
      Sardine_Behavior_Signals__c:  riskProfile.behaviorRisk.signals.join(", ") || "None",
      Sardine_Case_Status__c:       riskProfile.caseStatus,
      Sardine_Case_ID__c:           riskProfile.caseId || "",
      Sardine_Checkpoints_Passed__c: riskProfile.checkpointsPassed.join(", ") || "None",
      Sardine_Checkpoints_Failed__c: riskProfile.checkpointsFailed.join(", ") || "None",
    },
  };
}

async function upsertToSF(sfAccountId, fields) {
  try {
    const res = await axios.patch(
      `${SF_URL}/services/data/v58.0/sobjects/Account/${sfAccountId}`,
      fields,
      { headers: { "Content-Type": "application/json", Authorization: "Bearer mock-sf-token" } }
    );
    logEvent("sf_upsert_success", { sfAccountId, status: res.status, fieldCount: Object.keys(fields).length });
  } catch (e) {
    logEvent("sf_upsert_error", { sfAccountId, error: e.message });
  }
}

connApp.post("/webhook/sardine", async (req, res) => {
  const event = req.body;
  logEvent("webhook_received", {
    eventId: event.id, eventType: event.type,
    customerId: event.data?.customerId, sfAccountId: event.data?.sfAccountId,
    riskLevel: event.data?.riskProfile?.overallRiskLevel,
    fraudScore: event.data?.riskProfile?.fraudScore,
  });
  if (event.type === "customer.risk_updated") {
    const { sfAccountId, fields } = transformFields(event.data);
    await upsertToSF(sfAccountId, fields);
  }
  res.status(200).json({ received: true });
});

connApp.get("/events", (req, res) => res.json({ events: eventLog }));
connApp.get("/status", (req, res) => res.json({ service: "connector", status: "running" }));

connApp.listen(CONN_PORT, async () => {
  console.log(`[Connector] Running on port ${CONN_PORT}`);
  await new Promise(r => setTimeout(r, 1500));
  try {
    await axios.post(`${SARDINE_URL}/v1/webhooks/register`, {
      url: `${CONNECTOR_URL}/webhook/sardine`,
      events: ["customer.risk_updated", "customer.kyc_completed", "customer.case_created"],
    });
    logEvent("startup", { message: "Webhook registered with Sardine" });
    const { data } = await axios.get(`${SARDINE_URL}/v1/customers`);
    for (const c of data.customers) {
      const { sfAccountId, fields } = transformFields({ sfAccountId: c.sfAccountId, riskProfile: c.riskProfile });
      await upsertToSF(sfAccountId, fields);
    }
    logEvent("startup", { message: `Initial sync complete — ${data.total} customers` });
  } catch (e) {
    logEvent("startup_error", { message: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// 3. MOCK SALESFORCE + DASHBOARD UI
// ════════════════════════════════════════════════════════════
const sfApp = express();
sfApp.use(express.json());

const accounts = {
  "0015g00000XkYzAAA1": { Id: "0015g00000XkYzAAA1", Name: "Acme Corp", Industry: "Financial Services", AnnualRevenue: 4200000, Phone: "+1 (555) 010-1234", BillingCity: "San Francisco", BillingState: "CA", AccountOwner: "Sarah Chen", Type: "Customer", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA2": { Id: "0015g00000XkYzAAA2", Name: "Globex Financial", Industry: "Banking", AnnualRevenue: 18500000, Phone: "+1 (555) 020-5678", BillingCity: "New York", BillingState: "NY", AccountOwner: "Marcus Thompson", Type: "Customer", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA3": { Id: "0015g00000XkYzAAA3", Name: "Initech Payments", Industry: "Fintech", AnnualRevenue: 2100000, Phone: "+1 (555) 030-9012", BillingCity: "Austin", BillingState: "TX", AccountOwner: "Priya Patel", Type: "Prospect", Sardine_Risk_Level__c: "—", Sardine_Fraud_Score__c: null, Sardine_KYC_Status__c: "—", Sardine_KYC_Level__c: "—", Sardine_AML_Risk__c: "—", Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Signals__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_ID__c: "—", Sardine_Checkpoints_Passed__c: "—", Sardine_Checkpoints_Failed__c: "—", Sardine_Last_Updated__c: null, _updateHistory: [] },
};

sfApp.patch("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const a = accounts[req.params.id];
  if (!a) return res.status(404).json({ errorCode: "NOT_FOUND" });
  const prev = a.Sardine_Risk_Level__c;
  Object.assign(a, req.body);
  a._updateHistory.unshift({ timestamp: new Date().toISOString(), prevRisk: prev, newRisk: a.Sardine_Risk_Level__c, fraudScore: a.Sardine_Fraud_Score__c });
  if (a._updateHistory.length > 10) a._updateHistory.pop();
  console.log(`[Salesforce] PATCH ${a.Name} → ${a.Sardine_Risk_Level__c} score:${a.Sardine_Fraud_Score__c}`);
  res.status(204).send();
});

sfApp.get("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const a = accounts[req.params.id];
  if (!a) return res.status(404).json({ errorCode: "NOT_FOUND" });
  res.json(a);
});

sfApp.get("/api/accounts", (req, res) => res.json(Object.values(accounts)));
sfApp.get("/api/accounts/:id", (req, res) => {
  const a = accounts[req.params.id];
  if (!a) return res.status(404).json({ error: "Not found" });
  res.json(a);
});

// Proxy routes — browser can't reach localhost:3001/3002 directly
sfApp.get("/proxy/connector/events", async (req, res) => {
  try { res.json((await axios.get(`${CONNECTOR_URL}/events`, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
sfApp.get("/proxy/connector/status", async (req, res) => {
  try { res.json((await axios.get(`${CONNECTOR_URL}/status`, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
sfApp.post("/proxy/sardine/customers/:id/simulate", async (req, res) => {
  try { res.json((await axios.post(`${SARDINE_URL}/v1/customers/${req.params.id}/simulate`, req.body, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Serve the dashboard HTML inline (no static file dependency)
sfApp.get("/", (req, res) => {
  // Read index.html from same directory if present, otherwise serve inline
  const htmlPath = path.join(__dirname, "index.html");
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send("<h1>Dashboard</h1><p>index.html not found — place it in the same directory as server.js</p>");
  }
});

sfApp.listen(SF_PORT, () => {
  console.log(`[Salesforce] UI running on port ${SF_PORT}`);
  // Keep-alive ping to prevent Railway idle shutdown
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const url = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/accounts`;
    setInterval(async () => {
      try { await axios.get(url, { timeout: 5000 }); console.log("[Salesforce] Keep-alive OK"); }
      catch (e) { console.log(`[Salesforce] Keep-alive failed: ${e.message}`); }
    }, 4 * 60 * 1000);
  }
});
