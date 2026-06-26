/**
 * Sardine → Salesforce Connector — single entry point
 *
 * Reflects real Sardine webhook schemas based on API documentation:
 *   - alert.created / alert.updated
 *   - case.created / case.updated
 *   - document_verification.processed / document_verification.expired
 *   - sanctions screening (aml webhook)
 *
 * Three services in one Node process:
 *   [Sardine]     Mock Sardine API       → port 3001 (internal)
 *   [Connector]   Webhook + transformer  → port 3002 (internal)
 *   [Salesforce]  Mock SF API + UI       → process.env.PORT (Railway public port)
 */

"use strict";
const express = require("express");
const axios   = require("axios");
const { v4: uuidv4 } = require("uuid");

// ─── Ports ────────────────────────────────────────────────────────────────
const SARDINE_PORT = 3001;
const CONN_PORT    = 3002;
const SF_PORT      = parseInt(process.env.PORT || "3003", 10);

const SARDINE_URL = `http://localhost:${SARDINE_PORT}`;
const CONN_URL    = `http://localhost:${CONN_PORT}`;
const SF_URL      = `http://localhost:${SF_PORT}`;

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 1 — MOCK SARDINE API (port 3001)
// Emits real Sardine webhook shapes:
//   alert.created/updated, case.created/updated,
//   document_verification.processed, sanctions (aml)
// ══════════════════════════════════════════════════════════════════════════
const sardine = express();
sardine.use(express.json());

// ─── Customer database ────────────────────────────────────────────────────
// Risk levels match real Sardine API: low, medium, high, very_high
const customers = {
  "acct-001": {
    customerId:   "ea1dc905-0e8d-4d2d-897a-2f7688eddffb",
    sfAccountId:  "0015g00000XkYzAAA1",
    name:         "Acme Corp",
    email:        "high-risk@test.com",
    riskLevel:    "high",
    amlRiskScore: 72,
    kycStatus:    "approved",
    docVerification: {
      status:       "complete",
      riskLevel:    "high",
      forgeryLevel: "low",
      faceMatch:    "high",
      documentType: "DriversLicense",
    },
    sanctions: {
      matchScore: 0,
      riskScore:  0,
      hits:       { sanction: [], pep: [], adverseMedia: [] },
    },
    caseStatus:   "open",
    caseId:       "12345",
    caseName:     "High Risk Transaction Review",
    alertId:      "5228382501732353",
    alertStatus:  "in-progress",
    queueName:    "High Risk Queue",
    deviceRisk:   "high",
    deviceSignals: ["VPN:high", "Emulator:false", "Proxy:low"],
    behaviorBiometricRisk: "medium",
  },
  "acct-002": {
    customerId:   "3fb287c2-1f72-49e8-a75d-8cb76c81a89c",
    sfAccountId:  "0015g00000XkYzAAA2",
    name:         "Globex Financial",
    email:        "low-risk@test.com",
    riskLevel:    "low",
    amlRiskScore: 5,
    kycStatus:    "approved",
    docVerification: {
      status:       "complete",
      riskLevel:    "low",
      forgeryLevel: "low",
      faceMatch:    "high",
      documentType: "Passport",
    },
    sanctions: {
      matchScore: 0,
      riskScore:  0,
      hits:       { sanction: [], pep: [], adverseMedia: [] },
    },
    caseStatus:   "resolved",
    caseId:       null,
    caseName:     null,
    alertId:      null,
    alertStatus:  "resolved",
    queueName:    null,
    deviceRisk:   "low",
    deviceSignals: ["VPN:low", "Emulator:false", "Proxy:low"],
    behaviorBiometricRisk: "low",
  },
  "acct-003": {
    customerId:   "72d90f36-dce1-4fd6-9d1f-733840f93a7d",
    sfAccountId:  "0015g00000XkYzAAA3",
    name:         "Initech Payments",
    email:        "medium-risk@test.com",
    riskLevel:    "medium",
    amlRiskScore: 45,
    kycStatus:    "pending",
    docVerification: {
      status:       "complete",
      riskLevel:    "medium",
      forgeryLevel: "low",
      faceMatch:    "high",
      documentType: "IDCard",
    },
    sanctions: {
      matchScore: 50,
      riskScore:  50,
      hits: {
        sanction:    [],
        pep:         [{ sourceName: "UN Consolidated List", category: "Government" }],
        adverseMedia:[],
      },
    },
    caseStatus:   "open",
    caseId:       "12346",
    caseName:     "PEP Screening Review",
    alertId:      "5228382501732354",
    alertStatus:  "pending",
    queueName:    "AML Review Queue",
    deviceRisk:   "low",
    deviceSignals: ["VPN:low", "Emulator:false", "Proxy:low"],
    behaviorBiometricRisk: "low",
  },
};

let webhookEndpoints = [];

// ─── REST endpoints ───────────────────────────────────────────────────────
sardine.get("/v1/customers", (req, res) => {
  res.json({ customers: Object.values(customers), total: Object.keys(customers).length });
});

sardine.get("/v1/customers/:id", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

sardine.post("/v1/webhooks/register", (req, res) => {
  const { url, events } = req.body;
  webhookEndpoints.push({ id: uuidv4(), url, events });
  console.log(`[Sardine]  Webhook registered → ${url}`);
  res.json({ message: "Webhook registered" });
});

sardine.post("/v1/customers/:id/simulate", (req, res) => {
  const c = customers[req.params.id];
  if (!c) return res.status(404).json({ error: "Not found" });
  applyScenario(c, req.body.scenario || "escalate");
  fireWebhooks(c);
  res.json({ message: "Scenario applied", customer: c });
});

// ─── Scenario engine ──────────────────────────────────────────────────────
function applyScenario(c, scenario) {
  switch (scenario) {
    case "escalate":
      c.riskLevel    = "very_high";
      c.amlRiskScore = Math.min(99, c.amlRiskScore + 30);
      c.caseStatus   = "open";
      c.caseId       = c.caseId || String(Math.floor(Math.random() * 90000 + 10000));
      c.caseName     = "Escalated Risk Review";
      c.alertStatus  = "in-progress";
      c.deviceRisk   = "high";
      c.deviceSignals = ["VPN:high", "Proxy:high", "Emulator:false"];
      break;
    case "clear":
      c.riskLevel    = "low";
      c.amlRiskScore = Math.max(1, c.amlRiskScore - 40);
      c.caseStatus   = "resolved";
      c.alertStatus  = "resolved";
      c.deviceRisk   = "low";
      c.deviceSignals = ["VPN:low", "Proxy:low", "Emulator:false"];
      c.sanctions.hits = { sanction: [], pep: [], adverseMedia: [] };
      c.sanctions.matchScore = 0;
      c.sanctions.riskScore  = 0;
      c.kycStatus    = "approved";
      c.docVerification.riskLevel = "low";
      break;
    case "kyc_fail":
      c.kycStatus    = "rejected";
      c.riskLevel    = "high";
      c.docVerification.riskLevel    = "high";
      c.docVerification.forgeryLevel = "high";
      c.caseStatus   = "open";
      c.caseId       = c.caseId || String(Math.floor(Math.random() * 90000 + 10000));
      c.caseName     = "Document Verification Failed";
      break;
    case "aml_flag":
      c.amlRiskScore = 85;
      c.riskLevel    = "very_high";
      c.sanctions.matchScore = 80;
      c.sanctions.riskScore  = 80;
      c.sanctions.hits.sanction = [{ sourceName: "OFAC SDN List", category: "Sanctions" }];
      c.caseStatus   = "open";
      c.caseId       = c.caseId || String(Math.floor(Math.random() * 90000 + 10000));
      c.caseName     = "Sanctions Match Review";
      break;
  }
}

// ─── Webhook delivery — real Sardine payload shapes ───────────────────────
async function fireWebhooks(customer) {
  const now = new Date();
  const ts  = now.toISOString();

  // Build payloads matching real Sardine webhook schemas
  const payloads = [];

  // 1. Alert webhook (alert.created / alert.updated)
  payloads.push({
    id:        uuidv4(),
    type:      customer.alertId ? "alert.updated" : "alert.created",
    timestamp: ts,
    data: {
      action: { source: "rules_engine", value: customer.alertStatus === "resolved" ? "approve" : "none" },
      trigger: { triggerType: "rule", sourceId: "3539" },
      alert: {
        alertQueueId: customer.alertId || uuidv4(),
        customerId:   customer.customerId,
        sessionKey:   uuidv4(),
        status:       customer.alertStatus,
        assigneeEmail: "analyst@company.com",
        flowName:     "Customer Risk Assessment",
      },
      queue: {
        checkpoint: "customer",
        clientId:   uuidv4(),
        name:       customer.queueName || "Risk Review Queue",
        riskLevel:  [`riskLevel:${customer.riskLevel}`],
        type:       "customer",
      },
    },
  });

  // 2. Case webhook (case.created / case.updated) — only if case exists
  if (customer.caseId) {
    payloads.push({
      id:        uuidv4(),
      type:      "case.updated",
      timestamp: ts,
      clientId:  uuidv4(),
      data: {
        action:  { source: "rules_engine", value: "created" },
        trigger: { triggerType: "rule", sourceID: "23546" },
        caseDetails: {
          id:               parseInt(customer.caseId),
          type:             "customer",
          name:             customer.caseName || "Risk Review",
          status:           customer.caseStatus,
          decision:         customer.caseStatus === "resolved" ? "approve" : "none",
          assigneeEmail:    "analyst@company.com",
          linkedCustomers:  [customer.customerId],
          linkedAlerts:     customer.alertId ? [customer.alertId] : [],
        },
        queue: {
          queueId:   uuidv4(),
          queueName: customer.queueName || "Risk Review Queue",
        },
      },
    });
  }

  // 3. Sanctions webhook — only if there are hits or score > 0
  if (customer.sanctions.matchScore > 0 || customer.sanctions.hits.sanction.length > 0) {
    payloads.push({
      id:        uuidv4(),
      clientId:  uuidv4(),
      timestamp: Date.now(),
      webhook_data: {
        userIdHash: customer.customerId,
        signals:    [],
        aml: {
          entityName: customer.name,
          matchScore: customer.sanctions.matchScore,
          riskScore:  customer.sanctions.riskScore,
          sanction:   customer.sanctions.hits.sanction,
          pep:        customer.sanctions.hits.pep,
          adverseMedia: customer.sanctions.hits.adverseMedia,
        },
      },
    });
  }

  // 4. Document verification webhook
  if (customer.docVerification.status === "complete") {
    payloads.push({
      id:        uuidv4(),
      type:      "document_verification.processed",
      timestamp: ts,
      data: {
        action:  { source: "document_verification" },
        trigger: { triggerType: null, sourceID: null },
        case: {
          customerID:  customer.customerId,
          sessionKey:  uuidv4(),
        },
      },
      documentVerificationResult: {
        verificationId: uuidv4(),
        status:         customer.docVerification.status,
        documentData: {
          type: customer.docVerification.documentType,
        },
        verification: {
          riskLevel:         customer.docVerification.riskLevel,
          forgeryLevel:      customer.docVerification.forgeryLevel,
          faceMatchLevel:    customer.docVerification.faceMatch,
          imageQualityLevel: "high",
        },
      },
    });
  }

  // Deliver all payloads to registered endpoints
  for (const ep of webhookEndpoints) {
    for (const payload of payloads) {
      try {
        await axios.post(ep.url, payload, { timeout: 3000 });
        console.log(`[Sardine]  Webhook fired → ${payload.type || "sanctions"} to ${ep.url}`);
      } catch (e) {
        console.log(`[Sardine]  Webhook failed: ${e.message}`);
      }
    }
  }
}

// Auto-simulation every 30s
let simIdx = 0;
const simScenarios   = ["escalate", "clear", "kyc_fail", "aml_flag", "clear"];
const simCustomerIds = Object.keys(customers);
setInterval(() => {
  const c = customers[simCustomerIds[simIdx % simCustomerIds.length]];
  const s = simScenarios[simIdx % simScenarios.length];
  console.log(`[Sardine]  Auto-sim: ${c.name} → ${s}`);
  applyScenario(c, s);
  fireWebhooks(c);
  simIdx++;
}, 30000);

sardine.listen(SARDINE_PORT, () =>
  console.log(`[Sardine]  Running on port ${SARDINE_PORT}`));

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 2 — CONNECTOR (port 3002)
// Handles all real Sardine webhook event types and maps to SF fields
// ══════════════════════════════════════════════════════════════════════════
const connector = express();
connector.use(express.json());

const eventLog = [];
function logEvent(type, data) {
  const entry = { timestamp: new Date().toISOString(), type, ...data };
  eventLog.unshift(entry);
  if (eventLog.length > 50) eventLog.pop();
  console.log(`[Connector] ${type}: ${JSON.stringify(data).slice(0, 140)}`);
}

// ─── Risk level display mapping ───────────────────────────────────────────
// Real Sardine risk levels: low, medium, high, very_high
const RISK_DISPLAY = {
  low:       "🟢 Low",
  medium:    "🟡 Medium",
  high:      "🔴 High",
  very_high: "🚨 Very High",
};

// ─── SF field state (merged from all webhook types) ───────────────────────
// Keyed by customerId → accumulated SF fields
const customerFieldCache = {};

function mergeFields(customerId, fields) {
  if (!customerFieldCache[customerId]) customerFieldCache[customerId] = {};
  Object.assign(customerFieldCache[customerId], fields);
  return customerFieldCache[customerId];
}

// ─── Handlers per webhook type ────────────────────────────────────────────

function handleAlert(event) {
  const alert = event.data?.alert;
  const queue = event.data?.queue;
  if (!alert?.customerId) return null;

  const riskRaw   = (queue?.riskLevel?.[0] || "").replace("riskLevel:", "");
  const fields = {
    Sardine_Alert_ID__c:     alert.alertQueueId || "",
    Sardine_Alert_Status__c: alert.status || "",
    Sardine_Queue_Name__c:   queue?.name || "",
    Sardine_Risk_Level__c:   RISK_DISPLAY[riskRaw] || riskRaw || "—",
    Sardine_Last_Updated__c: event.timestamp || new Date().toISOString(),
  };
  return { customerId: alert.customerId, fields };
}

function handleCase(event) {
  const cd = event.data?.caseDetails;
  if (!cd || !cd.linkedCustomers?.[0]) return null;

  const fields = {
    Sardine_Case_ID__c:     String(cd.id || ""),
    Sardine_Case_Name__c:   cd.name || "",
    Sardine_Case_Status__c: cd.status || "",
    Sardine_Case_Decision__c: cd.decision || "",
    Sardine_Assignee__c:    cd.assigneeEmail || "",
    Sardine_Last_Updated__c: event.timestamp || new Date().toISOString(),
  };
  return { customerId: cd.linkedCustomers[0], fields };
}

function handleDocVerification(event) {
  const caseData = event.data?.case;
  const result   = event.documentVerificationResult;
  if (!caseData?.customerID || !result) return null;

  const v = result.verification || {};
  const d = result.documentData || {};
  const fields = {
    Sardine_Doc_Status__c:       result.status || "",
    Sardine_Doc_Type__c:         d.type || "",
    Sardine_Doc_Risk_Level__c:   RISK_DISPLAY[v.riskLevel] || v.riskLevel || "—",
    Sardine_Doc_Forgery__c:      v.forgeryLevel || "",
    Sardine_Doc_Face_Match__c:   v.faceMatchLevel || "",
    Sardine_Last_Updated__c:     event.timestamp || new Date().toISOString(),
  };
  return { customerId: caseData.customerID, fields };
}

function handleSanctions(event) {
  const wd  = event.webhook_data;
  const aml = wd?.aml;
  if (!wd?.userIdHash || !aml) return null;

  const hasSanction    = (aml.sanction?.length    || 0) > 0;
  const hasPep         = (aml.pep?.length          || 0) > 0;
  const hasAdverseMedia= (aml.adverseMedia?.length || 0) > 0;

  const fields = {
    Sardine_AML_Match_Score__c:    aml.matchScore ?? "",
    Sardine_AML_Risk_Score__c:     aml.riskScore  ?? "",
    Sardine_AML_Entity_Name__c:    aml.entityName || "",
    Sardine_Sanction_Hit__c:       hasSanction     ? "Yes" : "No",
    Sardine_PEP_Hit__c:            hasPep          ? "Yes" : "No",
    Sardine_Adverse_Media_Hit__c:  hasAdverseMedia ? "Yes" : "No",
    Sardine_Sanction_Source__c:    hasSanction     ? aml.sanction[0].sourceName : "",
    Sardine_Last_Updated__c:       new Date(event.timestamp).toISOString(),
  };
  return { customerId: wd.userIdHash, fields };
}

// ─── SF upsert ────────────────────────────────────────────────────────────
// Look up sfAccountId from customerId, then PATCH SF Account
const CUSTOMER_TO_SF = Object.fromEntries(
  Object.values(customers).map(c => [c.customerId, c.sfAccountId])
);

async function upsertToSF(customerId, newFields) {
  const sfAccountId = CUSTOMER_TO_SF[customerId];
  if (!sfAccountId) {
    logEvent("sf_upsert_skip", { customerId, reason: "no sfAccountId mapping" });
    return;
  }

  // Merge with previously received fields for this customer
  const merged = mergeFields(customerId, newFields);

  try {
    await axios.patch(
      `${SF_URL}/services/data/v58.0/sobjects/Account/${sfAccountId}`,
      merged,
      { headers: { Authorization: "Bearer mock-token" } }
    );
    logEvent("sf_upsert_success", {
      customerId, sfAccountId, fieldCount: Object.keys(merged).length,
    });
  } catch (e) {
    logEvent("sf_upsert_error", { customerId, sfAccountId, error: e.message });
  }
}

// ─── Webhook receiver ─────────────────────────────────────────────────────
connector.post("/webhook/sardine", async (req, res) => {
  const event = req.body;
  const type  = event.type || (event.webhook_data ? "sanctions" : "unknown");

  logEvent("webhook_received", { eventType: type, eventId: event.id });

  let result = null;
  if (type === "alert.created" || type === "alert.updated") {
    result = handleAlert(event);
  } else if (type === "case.created" || type === "case.updated") {
    result = handleCase(event);
  } else if (type === "document_verification.processed" || type === "document_verification.expired") {
    result = handleDocVerification(event);
  } else if (type === "sanctions") {
    result = handleSanctions(event);
  }

  if (result) {
    await upsertToSF(result.customerId, result.fields);
  }

  res.status(200).json({ received: true });
});

connector.get("/events", (req, res) => res.json({ events: eventLog }));
connector.get("/status", (req, res) => res.json({ service: "connector", status: "running" }));

connector.listen(CONN_PORT, async () => {
  console.log(`[Connector] Running on port ${CONN_PORT}`);
  await new Promise(r => setTimeout(r, 1500));
  try {
    await axios.post(`${SARDINE_URL}/v1/webhooks/register`, {
      url:    `${CONN_URL}/webhook/sardine`,
      events: ["alert.created", "alert.updated", "case.created", "case.updated",
               "document_verification.processed", "sanctions"],
    });
    logEvent("startup", { message: "Webhook registered with Sardine" });

    // Initial sync — fire all current customer states
    const { data } = await axios.get(`${SARDINE_URL}/v1/customers`);
    for (const c of data.customers) {
      await fireInitialSync(c);
    }
    logEvent("startup", { message: `Initial sync complete — ${data.total} customers` });
  } catch (e) {
    logEvent("startup_error", { message: e.message });
  }
});

async function fireInitialSync(c) {
  const sfAccountId = c.sfAccountId;
  if (!sfAccountId) return;

  const riskDisplay = RISK_DISPLAY[c.riskLevel] || c.riskLevel;
  const hasSanction = (c.sanctions?.hits?.sanction?.length || 0) > 0;
  const hasPep      = (c.sanctions?.hits?.pep?.length      || 0) > 0;
  const hasAM       = (c.sanctions?.hits?.adverseMedia?.length || 0) > 0;

  const fields = {
    Sardine_Risk_Level__c:         riskDisplay,
    Sardine_Alert_Status__c:       c.alertStatus || "",
    Sardine_Queue_Name__c:         c.queueName   || "",
    Sardine_Alert_ID__c:           c.alertId     || "",
    Sardine_Case_ID__c:            c.caseId      || "",
    Sardine_Case_Name__c:          c.caseName    || "",
    Sardine_Case_Status__c:        c.caseStatus  || "",
    Sardine_Case_Decision__c:      c.caseStatus === "resolved" ? "approve" : "none",
    Sardine_KYC_Status__c:         c.kycStatus   || "",
    Sardine_Doc_Status__c:         c.docVerification?.status     || "",
    Sardine_Doc_Type__c:           c.docVerification?.documentType || "",
    Sardine_Doc_Risk_Level__c:     RISK_DISPLAY[c.docVerification?.riskLevel] || "",
    Sardine_Doc_Forgery__c:        c.docVerification?.forgeryLevel || "",
    Sardine_Doc_Face_Match__c:     c.docVerification?.faceMatch    || "",
    Sardine_AML_Match_Score__c:    c.sanctions?.matchScore ?? "",
    Sardine_AML_Risk_Score__c:     c.sanctions?.riskScore  ?? "",
    Sardine_Sanction_Hit__c:       hasSanction ? "Yes" : "No",
    Sardine_PEP_Hit__c:            hasPep      ? "Yes" : "No",
    Sardine_Adverse_Media_Hit__c:  hasAM       ? "Yes" : "No",
    Sardine_Device_Risk__c:        RISK_DISPLAY[c.deviceRisk] || c.deviceRisk || "",
    Sardine_Device_Signals__c:     (c.deviceSignals || []).join(", "),
    Sardine_Behavior_Risk__c:      RISK_DISPLAY[c.behaviorBiometricRisk] || c.behaviorBiometricRisk || "",
    Sardine_Last_Updated__c:       new Date().toISOString(),
  };

  try {
    await axios.patch(
      `${SF_URL}/services/data/v58.0/sobjects/Account/${sfAccountId}`,
      fields,
      { headers: { Authorization: "Bearer mock-token" } }
    );
    logEvent("sf_upsert_success", { sfAccountId, fieldCount: Object.keys(fields).length });
  } catch (e) {
    logEvent("sf_upsert_error", { sfAccountId, error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SERVICE 3 — MOCK SALESFORCE API + DASHBOARD UI (process.env.PORT)
// ══════════════════════════════════════════════════════════════════════════
const sf = express();
sf.use(express.json());

const accounts = {
  "0015g00000XkYzAAA1": { Id: "0015g00000XkYzAAA1", Name: "Acme Corp",       Industry: "Financial Services", AnnualRevenue: 4200000,  Phone: "+1 (555) 010-1234", BillingCity: "San Francisco", BillingState: "CA", AccountOwner: "Sarah Chen",      Type: "Customer",
    Sardine_Risk_Level__c: "—", Sardine_Alert_Status__c: "—", Sardine_Queue_Name__c: "—", Sardine_Alert_ID__c: "—",
    Sardine_Case_ID__c: "—", Sardine_Case_Name__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_Decision__c: "—",
    Sardine_KYC_Status__c: "—", Sardine_Doc_Status__c: "—", Sardine_Doc_Type__c: "—", Sardine_Doc_Risk_Level__c: "—",
    Sardine_Doc_Forgery__c: "—", Sardine_Doc_Face_Match__c: "—",
    Sardine_AML_Match_Score__c: null, Sardine_AML_Risk_Score__c: null,
    Sardine_Sanction_Hit__c: "—", Sardine_PEP_Hit__c: "—", Sardine_Adverse_Media_Hit__c: "—",
    Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Risk__c: "—",
    Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA2": { Id: "0015g00000XkYzAAA2", Name: "Globex Financial", Industry: "Banking",            AnnualRevenue: 18500000, Phone: "+1 (555) 020-5678", BillingCity: "New York",      BillingState: "NY", AccountOwner: "Marcus Thompson", Type: "Customer",
    Sardine_Risk_Level__c: "—", Sardine_Alert_Status__c: "—", Sardine_Queue_Name__c: "—", Sardine_Alert_ID__c: "—",
    Sardine_Case_ID__c: "—", Sardine_Case_Name__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_Decision__c: "—",
    Sardine_KYC_Status__c: "—", Sardine_Doc_Status__c: "—", Sardine_Doc_Type__c: "—", Sardine_Doc_Risk_Level__c: "—",
    Sardine_Doc_Forgery__c: "—", Sardine_Doc_Face_Match__c: "—",
    Sardine_AML_Match_Score__c: null, Sardine_AML_Risk_Score__c: null,
    Sardine_Sanction_Hit__c: "—", Sardine_PEP_Hit__c: "—", Sardine_Adverse_Media_Hit__c: "—",
    Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Risk__c: "—",
    Sardine_Last_Updated__c: null, _updateHistory: [] },
  "0015g00000XkYzAAA3": { Id: "0015g00000XkYzAAA3", Name: "Initech Payments", Industry: "Fintech",            AnnualRevenue: 2100000,  Phone: "+1 (555) 030-9012", BillingCity: "Austin",        BillingState: "TX", AccountOwner: "Priya Patel",    Type: "Prospect",
    Sardine_Risk_Level__c: "—", Sardine_Alert_Status__c: "—", Sardine_Queue_Name__c: "—", Sardine_Alert_ID__c: "—",
    Sardine_Case_ID__c: "—", Sardine_Case_Name__c: "—", Sardine_Case_Status__c: "—", Sardine_Case_Decision__c: "—",
    Sardine_KYC_Status__c: "—", Sardine_Doc_Status__c: "—", Sardine_Doc_Type__c: "—", Sardine_Doc_Risk_Level__c: "—",
    Sardine_Doc_Forgery__c: "—", Sardine_Doc_Face_Match__c: "—",
    Sardine_AML_Match_Score__c: null, Sardine_AML_Risk_Score__c: null,
    Sardine_Sanction_Hit__c: "—", Sardine_PEP_Hit__c: "—", Sardine_Adverse_Media_Hit__c: "—",
    Sardine_Device_Risk__c: "—", Sardine_Device_Signals__c: "—", Sardine_Behavior_Risk__c: "—",
    Sardine_Last_Updated__c: null, _updateHistory: [] },
};

sf.patch("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const a = accounts[req.params.id];
  if (!a) return res.status(404).json({ errorCode: "NOT_FOUND" });
  const prev = a.Sardine_Risk_Level__c;
  Object.assign(a, req.body);
  a._updateHistory.unshift({ timestamp: new Date().toISOString(), prevRisk: prev, newRisk: a.Sardine_Risk_Level__c });
  if (a._updateHistory.length > 10) a._updateHistory.pop();
  console.log(`[Salesforce] PATCH ${a.Name} → risk:${a.Sardine_Risk_Level__c}`);
  res.status(204).send();
});

sf.get("/api/accounts",     (req, res) => res.json(Object.values(accounts)));
sf.get("/api/accounts/:id", (req, res) => res.json(accounts[req.params.id] || { error: "Not found" }));

// Proxy routes
sf.get("/proxy/connector/events", async (req, res) => {
  try { res.json((await axios.get(`${CONN_URL}/events`, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
sf.post("/proxy/sardine/customers/:id/simulate", async (req, res) => {
  try { res.json((await axios.post(`${SARDINE_URL}/v1/customers/${req.params.id}/simulate`, req.body, { timeout: 3000 })).data); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

sf.get("/", (req, res) => res.send(getDashboardHTML()));

sf.listen(SF_PORT, () => {
  console.log(`[Salesforce] UI running on port ${SF_PORT}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const url = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/accounts`;
    setInterval(async () => {
      try { await axios.get(url, { timeout: 5000 }); console.log("[Salesforce] Keep-alive OK"); }
      catch (e) { console.log(`[Salesforce] Keep-alive failed: ${e.message}`); }
    }, 4 * 60 * 1000);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD HTML
// ══════════════════════════════════════════════════════════════════════════
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sardine Risk Intelligence — Salesforce</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--sf-navy:#032d60;--sf-blue:#0176d3;--sf-bg:#f3f3f3;--sf-white:#fff;--sf-border:#dddbda;--sf-text:#181818;--sf-muted:#706e6b;--sf-label:#514f4d;--sardine-ink:#1a1033;--risk-low:#2e844a;--risk-low-bg:#eaf5ea;--risk-med:#dd7a01;--risk-med-bg:#fdf3e3;--risk-high:#ba0517;--risk-high-bg:#fde8e8;--font-ui:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono',monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-ui);background:var(--sf-bg);color:var(--sf-text);font-size:13px;min-height:100vh}
.sf-header{background:var(--sf-navy);height:48px;display:flex;align-items:center;padding:0 16px;gap:12px;position:sticky;top:0;z-index:100}
.sf-logo{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.5px}.sf-logo span{color:#88c3fb}
.sf-nav{display:flex;gap:2px;margin-left:12px}
.sf-nav-item{color:#d8edff;font-size:12px;font-weight:500;padding:4px 12px;border-radius:4px;cursor:pointer}
.sf-nav-item.active{background:rgba(255,255,255,.18);color:#fff}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.conn-status{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);padding:3px 10px;border-radius:100px;font-size:11px;color:#88c3fb}
.dot{width:7px;height:7px;border-radius:50%;background:#3dd68c;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.last-refresh{font-size:10px;color:#88c3fb}
.page{max-width:1280px;margin:0 auto;padding:20px 16px 40px}
.acct-tabs{display:flex;gap:1px;background:var(--sf-border);border-radius:6px 6px 0 0;overflow:hidden;border:1px solid var(--sf-border);border-bottom:none;width:fit-content}
.acct-tab{padding:8px 18px;background:#e8e8e8;cursor:pointer;font-size:12px;font-weight:500;color:var(--sf-muted);display:flex;align-items:center;gap:6px}
.acct-tab.active{background:var(--sf-white);color:var(--sf-blue);font-weight:600}
.tab-dot{width:8px;height:8px;border-radius:50%;background:#ccc}
.record{background:var(--sf-white);border:1px solid var(--sf-border);border-top:3px solid var(--sf-blue);border-radius:0 6px 6px 6px}
.rec-hdr{padding:14px 20px;border-bottom:1px solid var(--sf-border);display:flex;align-items:flex-start;gap:12px}
.rec-icon{width:36px;height:36px;background:var(--sf-blue);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.rec-name{font-size:18px;font-weight:700;color:var(--sf-navy)}
.rec-meta{display:flex;gap:16px;margin-top:3px}
.rec-meta-item{font-size:11px;color:var(--sf-muted)}.rec-meta-item strong{color:var(--sf-label);font-weight:500}
.hl-bar{display:flex;border-bottom:1px solid var(--sf-border);overflow-x:auto}
.hl-item{padding:10px 16px;border-right:1px solid var(--sf-border);min-width:100px;flex-shrink:0}
.hl-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-muted);margin-bottom:3px}
.hl-value{font-size:13px;font-weight:600}
.rec-body{display:grid;grid-template-columns:1fr 400px;min-height:520px}
.rec-left{padding:20px;border-right:1px solid var(--sf-border)}
.rec-right{background:#f8f8f8}
.sec-hdr{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--sf-muted);margin-bottom:10px;padding-bottom:5px;border-bottom:1px solid var(--sf-border)}
.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-bottom:20px}
.field-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--sf-muted);margin-bottom:2px}
.field-value{font-size:13px;color:var(--sf-text)}
.field-value.link{color:var(--sf-blue)}
.sardine-panel{height:100%;display:flex;flex-direction:column}
.sp-hdr{padding:11px 14px;background:var(--sardine-ink);display:flex;align-items:center;gap:8px}
.sp-wordmark{font-size:13px;font-weight:700;color:#fff}.sp-wordmark span{color:#a78bfa}
.sp-sub{font-size:10px;color:#a0a0c0;margin-left:auto}
.sp-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;flex:1;overflow-y:auto}
.risk-hero{border:1px solid var(--sf-border);border-radius:6px;padding:12px 14px;background:var(--sf-white);display:flex;align-items:center;justify-content:space-between}
.risk-badge{font-size:13px;font-weight:700;padding:4px 14px;border-radius:100px}
.risk-badge.low{background:var(--risk-low-bg);color:var(--risk-low)}
.risk-badge.medium{background:var(--risk-med-bg);color:var(--risk-med)}
.risk-badge.high,.risk-badge.very_high{background:var(--risk-high-bg);color:var(--risk-high)}
.risk-sub{font-size:11px;color:var(--sf-muted);margin-top:2px}
.sig-group{border:1px solid var(--sf-border);border-radius:6px;background:var(--sf-white);overflow:hidden}
.sig-grp-hdr{padding:6px 12px;background:#f4f4f4;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-label);border-bottom:1px solid var(--sf-border)}
.sig-row{display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #f0f0f0;gap:8px}
.sig-row:last-child{border-bottom:none}
.sig-key{font-size:11px;color:var(--sf-label);font-weight:500;min-width:100px;flex-shrink:0}
.sig-val{font-size:11px;font-weight:600;flex:1}
.hit-yes{color:var(--risk-high)}.hit-no{color:var(--risk-low)}
.score-pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:100px;font-family:var(--font-mono)}
.score-pill.low{background:var(--risk-low-bg);color:var(--risk-low)}
.score-pill.medium{background:var(--risk-med-bg);color:var(--risk-med)}
.score-pill.high{background:var(--risk-high-bg);color:var(--risk-high)}
.evlog{border:1px solid var(--sf-border);border-radius:6px;background:var(--sf-white);overflow:hidden}
.evlog-hdr{padding:6px 12px;background:#f4f4f4;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--sf-label);border-bottom:1px solid var(--sf-border)}
.evlog-list{max-height:120px;overflow-y:auto}
.ev-item{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid #f4f4f4;font-size:11px}
.ev-item:last-child{border-bottom:none}
.ev-time{font-family:var(--font-mono);font-size:10px;color:var(--sf-muted);white-space:nowrap;min-width:58px}
.ev-desc{color:var(--sf-text);line-height:1.4;flex:1}
.ev-tag{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;white-space:nowrap;margin-left:auto}
.ev-tag.alert{background:#e8f0fe;color:#1a73e8}
.ev-tag.case{background:#fde8e8;color:#ba0517}
.ev-tag.doc{background:#eaf5ea;color:#2e844a}
.ev-tag.sanctions{background:#fdf3e3;color:#dd7a01}
.demo-ctrl{border-top:2px dashed #d0d0d0;padding:12px 14px;background:#fffbf0}
.demo-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#999;margin-bottom:7px}
.demo-btns{display:flex;flex-wrap:wrap;gap:5px}
.demo-btn{font-size:11px;font-weight:600;font-family:var(--font-ui);padding:5px 10px;border-radius:4px;border:1px solid;cursor:pointer;transition:opacity .15s}
.demo-btn:hover{opacity:.85}
.demo-btn.danger{background:var(--risk-high-bg);color:var(--risk-high);border-color:#f5b8b8}
.demo-btn.warning{background:var(--risk-med-bg);color:var(--risk-med);border-color:#f5d8a0}
.demo-btn.success{background:var(--risk-low-bg);color:var(--risk-low);border-color:#b0e0b8}
.conn-log{margin-top:14px;border:1px solid var(--sf-border);border-radius:6px;background:var(--sardine-ink);overflow:hidden}
.conn-log-hdr{padding:5px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,.08)}
.conn-log-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8888aa}
.conn-log-body{max-height:80px;overflow-y:auto;padding:4px 0}
.log-line{font-family:var(--font-mono);font-size:10px;padding:2px 12px;display:flex;gap:8px}
.log-t{color:#5060a0}.log-type{color:#88c3fb;font-weight:600}.log-msg{color:#c0c0e0}
.log-line.ok .log-msg{color:#3dd68c}.log-line.err .log-msg{color:#f87171}
@keyframes flash{0%{background:#fff9c4}100%{background:transparent}}
.flash{animation:flash 1s ease-out}
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-thumb{background:#ccc;border-radius:2px}
</style>
</head>
<body>
<header class="sf-header">
  <div class="sf-logo">☁ Sales<span>force</span></div>
  <nav class="sf-nav">
    <div class="sf-nav-item">Home</div>
    <div class="sf-nav-item active">Accounts</div>
    <div class="sf-nav-item">Cases</div>
  </nav>
  <div class="hdr-right">
    <div class="conn-status"><div class="dot"></div><span>Sardine connector active</span></div>
    <div class="last-refresh" id="lastRefresh">—</div>
  </div>
</header>

<div class="page">
  <div class="acct-tabs" id="tabs"></div>
  <div class="record">
    <div class="rec-hdr">
      <div class="rec-icon">🏢</div>
      <div>
        <div class="rec-name" id="recName">Loading…</div>
        <div class="rec-meta">
          <div class="rec-meta-item"><strong>Industry:</strong> <span id="metaIndustry">—</span></div>
          <div class="rec-meta-item"><strong>Owner:</strong> <span id="metaOwner">—</span></div>
          <div class="rec-meta-item"><strong>Type:</strong> <span id="metaType">—</span></div>
        </div>
      </div>
    </div>
    <div class="hl-bar">
      <div class="hl-item"><div class="hl-label">Sardine Risk</div><div class="hl-value" id="hlRisk">—</div></div>
      <div class="hl-item"><div class="hl-label">Alert Status</div><div class="hl-value" id="hlAlert">—</div></div>
      <div class="hl-item"><div class="hl-label">Case Status</div><div class="hl-value" id="hlCase">—</div></div>
      <div class="hl-item"><div class="hl-label">KYC Status</div><div class="hl-value" id="hlKyc">—</div></div>
      <div class="hl-item"><div class="hl-label">Sanction Hit</div><div class="hl-value" id="hlSanction">—</div></div>
      <div class="hl-item"><div class="hl-label">AML Score</div><div class="hl-value" id="hlAml">—</div></div>
      <div class="hl-item"><div class="hl-label">Annual Revenue</div><div class="hl-value" id="hlRevenue">—</div></div>
    </div>
    <div class="rec-body">
      <div class="rec-left">
        <div class="sec-hdr">Account Information</div>
        <div class="field-grid">
          <div><div class="field-label">Account Name</div><div class="field-value link" id="fName">—</div></div>
          <div><div class="field-label">Industry</div><div class="field-value" id="fIndustry">—</div></div>
          <div><div class="field-label">Phone</div><div class="field-value" id="fPhone">—</div></div>
          <div><div class="field-label">Annual Revenue</div><div class="field-value" id="fRevenue">—</div></div>
          <div><div class="field-label">Billing City</div><div class="field-value" id="fCity">—</div></div>
          <div><div class="field-label">Account Owner</div><div class="field-value link" id="fOwner">—</div></div>
        </div>
        <div class="sec-hdr">Case & Alert</div>
        <div class="field-grid">
          <div><div class="field-label">Case ID</div><div class="field-value link" id="fCaseId">—</div></div>
          <div><div class="field-label">Case Name</div><div class="field-value" id="fCaseName">—</div></div>
          <div><div class="field-label">Case Status</div><div class="field-value" id="fCaseStatus">—</div></div>
          <div><div class="field-label">Decision</div><div class="field-value" id="fCaseDecision">—</div></div>
          <div><div class="field-label">Alert ID</div><div class="field-value" id="fAlertId">—</div></div>
          <div><div class="field-label">Queue</div><div class="field-value" id="fQueue">—</div></div>
        </div>
        <div class="sec-hdr">Recent Sardine Events</div>
        <div class="evlog"><div class="evlog-list" id="sardineEvents"><div class="ev-item"><div class="ev-desc" style="color:#aaa">Awaiting events…</div></div></div></div>
      </div>
      <div class="rec-right">
        <div class="sardine-panel">
          <div class="sp-hdr">
            <div style="font-size:15px">🐟</div>
            <div class="sp-wordmark">sardine<span> risk</span></div>
            <div class="sp-sub" id="spSub">Last sync: —</div>
          </div>
          <div class="sp-body">
            <div class="risk-hero" id="riskHero">
              <div>
                <div class="risk-badge" id="riskBadge">—</div>
                <div class="risk-sub" id="riskSub">Overall Risk Level</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:10px;color:var(--sf-muted);margin-bottom:2px">Alert Status</div>
                <div style="font-size:13px;font-weight:600" id="alertStatusVal">—</div>
              </div>
            </div>

            <div class="sig-group">
              <div class="sig-grp-hdr">AML / Sanctions Screening</div>
              <div class="sig-row"><span class="sig-key">AML Match Score</span><span class="sig-val" id="sigAmlMatch">—</span></div>
              <div class="sig-row"><span class="sig-key">AML Risk Score</span><span class="sig-val" id="sigAmlRisk">—</span></div>
              <div class="sig-row"><span class="sig-key">Sanction Hit</span><span class="sig-val" id="sigSanction">—</span></div>
              <div class="sig-row"><span class="sig-key">PEP Hit</span><span class="sig-val" id="sigPep">—</span></div>
              <div class="sig-row"><span class="sig-key">Adverse Media</span><span class="sig-val" id="sigAdverse">—</span></div>
            </div>

            <div class="sig-group">
              <div class="sig-grp-hdr">Document Verification</div>
              <div class="sig-row"><span class="sig-key">Status</span><span class="sig-val" id="sigDocStatus">—</span></div>
              <div class="sig-row"><span class="sig-key">Doc Type</span><span class="sig-val" id="sigDocType">—</span></div>
              <div class="sig-row"><span class="sig-key">Risk Level</span><span class="sig-val" id="sigDocRisk">—</span></div>
              <div class="sig-row"><span class="sig-key">Forgery</span><span class="sig-val" id="sigForgery">—</span></div>
              <div class="sig-row"><span class="sig-key">Face Match</span><span class="sig-val" id="sigFaceMatch">—</span></div>
            </div>

            <div class="sig-group">
              <div class="sig-grp-hdr">Device & Behavior</div>
              <div class="sig-row"><span class="sig-key">Device Risk</span><span class="sig-val" id="sigDevRisk">—</span></div>
              <div class="sig-row"><span class="sig-key">Device Signals</span><span class="sig-val" id="sigDevSig">—</span></div>
              <div class="sig-row"><span class="sig-key">Behavior Risk</span><span class="sig-val" id="sigBehav">—</span></div>
            </div>

            <div class="evlog">
              <div class="evlog-hdr">Connector Event Stream</div>
              <div class="evlog-list" id="connEvents"><div class="ev-item"><div class="ev-desc" style="color:#aaa">Awaiting events…</div></div></div>
            </div>
          </div>
          <div class="demo-ctrl">
            <div class="demo-lbl">🎮 Demo Controls</div>
            <div class="demo-btns" id="demoBtns"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let accounts = [], selectedId = null, connEvents = [];

const fmt = v => (v !== null && v !== undefined && v !== '') ? v : '—';
const fmtRev = n => !n ? '—' : '\$' + (n >= 1e6 ? (n/1e6).toFixed(1)+'M' : (n/1e3).toFixed(0)+'K');
const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); } catch(e){ return '—'; }};
const riskKey = str => {
  const s = (str||'').toLowerCase();
  if (s.includes('very') || s.includes('🚨')) return 'very_high';
  if (s.includes('high') || s.includes('🔴')) return 'high';
  if (s.includes('med')  || s.includes('🟡')) return 'medium';
  return 'low';
};
const hitClass = v => v === 'Yes' ? 'hit-yes' : v === 'No' ? 'hit-no' : '';
const scoreClass = n => n == null ? '' : n >= 70 ? 'high' : n >= 40 ? 'medium' : 'low';
const riskColors = { low:'#2e844a', medium:'#dd7a01', high:'#ba0517', very_high:'#ba0517' };

function renderTabs() {
  document.getElementById('tabs').innerHTML = accounts.map(a => {
    const rk = riskKey(a.Sardine_Risk_Level__c);
    return \`<div class="acct-tab\${a.Id===selectedId?' active':''}" onclick="select('\${a.Id}')">
      <div class="tab-dot" style="background:\${riskColors[rk]||'#ccc'}"></div>\${a.Name}</div>\`;
  }).join('');
}

function select(id) { selectedId = id; renderTabs(); renderAccount(); }

function renderAccount() {
  const a = accounts.find(x => x.Id === selectedId); if (!a) return;

  document.getElementById('recName').textContent      = a.Name;
  document.getElementById('metaIndustry').textContent = fmt(a.Industry);
  document.getElementById('metaOwner').textContent    = fmt(a.AccountOwner);
  document.getElementById('metaType').textContent     = fmt(a.Type);

  document.getElementById('hlRisk').textContent     = fmt(a.Sardine_Risk_Level__c);
  document.getElementById('hlAlert').textContent    = fmt(a.Sardine_Alert_Status__c);
  document.getElementById('hlCase').textContent     = fmt(a.Sardine_Case_Status__c);
  document.getElementById('hlKyc').textContent      = fmt(a.Sardine_KYC_Status__c);
  document.getElementById('hlSanction').textContent = fmt(a.Sardine_Sanction_Hit__c);
  document.getElementById('hlAml').textContent      = a.Sardine_AML_Risk_Score__c != null ? a.Sardine_AML_Risk_Score__c+'/100' : '—';
  document.getElementById('hlRevenue').textContent  = fmtRev(a.AnnualRevenue);

  document.getElementById('fName').textContent    = fmt(a.Name);
  document.getElementById('fIndustry').textContent = fmt(a.Industry);
  document.getElementById('fPhone').textContent   = fmt(a.Phone);
  document.getElementById('fRevenue').textContent = fmtRev(a.AnnualRevenue);
  document.getElementById('fCity').textContent    = [a.BillingCity,a.BillingState].filter(Boolean).join(', ')||'—';
  document.getElementById('fOwner').textContent   = fmt(a.AccountOwner);

  document.getElementById('fCaseId').textContent      = fmt(a.Sardine_Case_ID__c);
  document.getElementById('fCaseName').textContent    = fmt(a.Sardine_Case_Name__c);
  document.getElementById('fCaseStatus').textContent  = fmt(a.Sardine_Case_Status__c);
  document.getElementById('fCaseDecision').textContent = fmt(a.Sardine_Case_Decision__c);
  document.getElementById('fAlertId').textContent     = fmt(a.Sardine_Alert_ID__c);
  document.getElementById('fQueue').textContent       = fmt(a.Sardine_Queue_Name__c);

  const rk = riskKey(a.Sardine_Risk_Level__c);
  const badge = document.getElementById('riskBadge');
  badge.textContent = fmt(a.Sardine_Risk_Level__c);
  badge.className = \`risk-badge \${rk}\`;
  document.getElementById('alertStatusVal').textContent = fmt(a.Sardine_Alert_Status__c);

  const amlM = a.Sardine_AML_Match_Score__c;
  const amlR = a.Sardine_AML_Risk_Score__c;
  document.getElementById('sigAmlMatch').innerHTML = amlM != null ? \`<span class="score-pill \${scoreClass(amlM)}">\${amlM}</span>\` : '—';
  document.getElementById('sigAmlRisk').innerHTML  = amlR != null ? \`<span class="score-pill \${scoreClass(amlR)}">\${amlR}</span>\` : '—';
  document.getElementById('sigSanction').innerHTML = \`<span class="\${hitClass(a.Sardine_Sanction_Hit__c)}">\${fmt(a.Sardine_Sanction_Hit__c)}</span>\`;
  document.getElementById('sigPep').innerHTML      = \`<span class="\${hitClass(a.Sardine_PEP_Hit__c)}">\${fmt(a.Sardine_PEP_Hit__c)}</span>\`;
  document.getElementById('sigAdverse').innerHTML  = \`<span class="\${hitClass(a.Sardine_Adverse_Media_Hit__c)}">\${fmt(a.Sardine_Adverse_Media_Hit__c)}</span>\`;

  document.getElementById('sigDocStatus').textContent  = fmt(a.Sardine_Doc_Status__c);
  document.getElementById('sigDocType').textContent    = fmt(a.Sardine_Doc_Type__c);
  document.getElementById('sigDocRisk').textContent    = fmt(a.Sardine_Doc_Risk_Level__c);
  document.getElementById('sigForgery').textContent    = fmt(a.Sardine_Doc_Forgery__c);
  document.getElementById('sigFaceMatch').textContent  = fmt(a.Sardine_Doc_Face_Match__c);

  document.getElementById('sigDevRisk').textContent = fmt(a.Sardine_Device_Risk__c);
  document.getElementById('sigDevSig').textContent  = fmt(a.Sardine_Device_Signals__c);
  document.getElementById('sigBehav').textContent   = fmt(a.Sardine_Behavior_Risk__c);

  document.getElementById('spSub').textContent = a.Sardine_Last_Updated__c ? 'Synced '+fmtTime(a.Sardine_Last_Updated__c) : 'Not yet synced';

  const sardineIds = {'0015g00000XkYzAAA1':'acct-001','0015g00000XkYzAAA2':'acct-002','0015g00000XkYzAAA3':'acct-003'};
  renderDemoBtns(sardineIds[a.Id]);
  renderSardineEvents(a.Id);
}

function renderDemoBtns(sardineId) {
  document.getElementById('demoBtns').innerHTML = sardineId ? \`
    <button class="demo-btn danger"  onclick="trigger('\${sardineId}','escalate')">🚨 Very High Risk</button>
    <button class="demo-btn danger"  onclick="trigger('\${sardineId}','aml_flag')">⛔ AML / Sanctions</button>
    <button class="demo-btn warning" onclick="trigger('\${sardineId}','kyc_fail')">⚠️ KYC / Doc Fail</button>
    <button class="demo-btn success" onclick="trigger('\${sardineId}','clear')">✅ Clear & Resolve</button>\` : '';
}

async function trigger(sardineId, scenario) {
  try {
    await fetch(\`/proxy/sardine/customers/\${sardineId}/simulate\`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario})
    });
    setTimeout(poll,700); setTimeout(poll,2000);
  } catch(e){ console.error(e); }
}

const EVENT_TAGS = {
  'alert.created':'alert','alert.updated':'alert',
  'case.created':'case','case.updated':'case',
  'document_verification.processed':'doc','document_verification.expired':'doc',
  'sanctions':'sanctions',
};

async function pollEvents() {
  try {
    const r = await fetch('/proxy/connector/events');
    const data = await r.json();
    const events = data.events||[];
    const newEvs = events.filter(e => !connEvents.find(x => x.timestamp===e.timestamp&&x.type===e.type));
    if (newEvs.length) { connEvents = events; renderConnEvents(); renderSardineEvents(selectedId); }
  } catch(e){}
}

function renderConnEvents() {
  document.getElementById('connEvents').innerHTML = connEvents.slice(0,10).map(e => {
    const cls = e.type?.includes('error')?'err':e.type?.includes('success')?'ok':'';
    const msg = e.type==='webhook_received' ? \`\${e.eventType} received\`
      : e.type==='sf_upsert_success' ? \`upsert OK → \${e.sfAccountId} (\${e.fieldCount} fields)\`
      : e.message||e.type||'event';
    return \`<div class="log-line \${cls}"><span class="log-t">\${fmtTime(e.timestamp)}</span><span class="log-type">\${e.type||''}</span><span class="log-msg">\${msg}</span></div>\`;
  }).join('')||'<div class="log-line"><span class="log-msg" style="color:#555">No events</span></div>';
}

function renderSardineEvents(sfId) {
  const relevant = connEvents.filter(e => e.type==='webhook_received').slice(0,8);
  document.getElementById('sardineEvents').innerHTML = relevant.length
    ? relevant.map(e => {
        const tag = EVENT_TAGS[e.eventType]||'alert';
        return \`<div class="ev-item">
          <div class="ev-time">\${fmtTime(e.timestamp)}</div>
          <div class="ev-desc">\${e.eventType||'event'}</div>
          <div class="ev-tag \${tag}">\${tag}</div>
        </div>\`;
      }).join('')
    : '<div class="ev-item"><div class="ev-desc" style="color:#aaa">No events yet</div></div>';
}

async function poll() {
  try {
    const r = await fetch('/api/accounts');
    accounts = await r.json();
    document.getElementById('lastRefresh').textContent = 'Updated '+fmtTime(new Date().toISOString());
    if (!selectedId && accounts.length) selectedId = accounts[0].Id;
    renderTabs(); renderAccount();
  } catch(e){ document.getElementById('lastRefresh').textContent = 'Connection error'; }
}

(async()=>{ await poll(); await pollEvents(); setInterval(poll,3000); setInterval(pollEvents,2000); })();
</script>
</body>
</html>`;
}
