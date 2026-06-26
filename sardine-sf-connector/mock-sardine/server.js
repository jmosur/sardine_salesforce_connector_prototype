/**
 * Mock Sardine API Server (port 3001)
 *
 * Simulates Sardine's customer risk API and webhook delivery.
 * Serves risk profiles for accounts, and fires webhook events
 * when risk signals change (simulated on a timer).
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const app = express();
app.use(express.json());

// ─── Mock Customer Database ────────────────────────────────────────────────
const customers = {
  "acct-001": {
    id: "acct-001",
    sfAccountId: "0015g00000XkYzAAA1",
    name: "Acme Corp",
    email: "finance@acme.com",
    sardineCustomerId: "sardine-cust-abc123",
    riskProfile: {
      overallRiskLevel: "HIGH",
      fraudScore: 82,
      kycStatus: "APPROVED",
      kycLevel: "ENHANCED",
      amlRiskLevel: "MEDIUM",
      deviceRisk: {
        level: "HIGH",
        signals: ["vpn_detected", "velocity_abuse", "emulator_suspected"],
        fingerprint: "fp-d8a7c3b2",
      },
      behaviorRisk: {
        level: "MEDIUM",
        signals: ["unusual_login_time", "new_device"],
      },
      caseStatus: "UNDER_REVIEW",
      caseId: "case-7821",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified"],
      checkpointsFailed: ["device_trust"],
    },
  },
  "acct-002": {
    id: "acct-002",
    sfAccountId: "0015g00000XkYzAAA2",
    name: "Globex Financial",
    email: "compliance@globex.com",
    sardineCustomerId: "sardine-cust-def456",
    riskProfile: {
      overallRiskLevel: "LOW",
      fraudScore: 12,
      kycStatus: "APPROVED",
      kycLevel: "STANDARD",
      amlRiskLevel: "LOW",
      deviceRisk: {
        level: "LOW",
        signals: [],
        fingerprint: "fp-a1b2c3d4",
      },
      behaviorRisk: {
        level: "LOW",
        signals: [],
      },
      caseStatus: "CLEARED",
      caseId: null,
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["kyc_basic", "email_verified", "device_trust", "aml_screening"],
      checkpointsFailed: [],
    },
  },
  "acct-003": {
    id: "acct-003",
    sfAccountId: "0015g00000XkYzAAA3",
    name: "Initech Payments",
    email: "ops@initech.io",
    sardineCustomerId: "sardine-cust-ghi789",
    riskProfile: {
      overallRiskLevel: "MEDIUM",
      fraudScore: 47,
      kycStatus: "PENDING",
      kycLevel: "STANDARD",
      amlRiskLevel: "LOW",
      deviceRisk: {
        level: "LOW",
        signals: ["tor_exit_node"],
        fingerprint: "fp-e5f6g7h8",
      },
      behaviorRisk: {
        level: "MEDIUM",
        signals: ["high_transaction_velocity"],
      },
      caseStatus: "OPEN",
      caseId: "case-7955",
      lastChecked: new Date().toISOString(),
      checkpointsPassed: ["email_verified"],
      checkpointsFailed: ["kyc_basic"],
    },
  },
};

// ─── Webhook Registry ──────────────────────────────────────────────────────
let webhookEndpoints = [];

// ─── REST Endpoints ────────────────────────────────────────────────────────

// GET /v1/customers/:id — fetch risk profile
app.get("/v1/customers/:id", (req, res) => {
  const customer = customers[req.params.id];
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  customer.riskProfile.lastChecked = new Date().toISOString();
  console.log(`[Sardine] GET /v1/customers/${req.params.id} → ${customer.riskProfile.overallRiskLevel}`);
  res.json(customer);
});

// GET /v1/customers — list all customers
app.get("/v1/customers", (req, res) => {
  console.log(`[Sardine] GET /v1/customers → ${Object.keys(customers).length} records`);
  res.json({ customers: Object.values(customers), total: Object.keys(customers).length });
});

// POST /v1/webhooks/register — connector registers its callback URL
app.post("/v1/webhooks/register", (req, res) => {
  const { url, events } = req.body;
  const id = uuidv4();
  webhookEndpoints.push({ id, url, events });
  console.log(`[Sardine] Webhook registered: ${url} for events: ${events.join(", ")}`);
  res.json({ id, message: "Webhook registered successfully" });
});

// POST /v1/customers/:id/simulate — trigger a risk change for demo purposes
app.post("/v1/customers/:id/simulate", (req, res) => {
  const customer = customers[req.params.id];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const { scenario } = req.body;
  applyScenario(customer, scenario || "escalate");
  fireWebhooks(customer, "customer.risk_updated");
  res.json({ message: `Scenario '${scenario}' applied`, riskProfile: customer.riskProfile });
});

// ─── Scenario Engine ───────────────────────────────────────────────────────
function applyScenario(customer, scenario) {
  const p = customer.riskProfile;
  switch (scenario) {
    case "escalate":
      p.overallRiskLevel = "HIGH";
      p.fraudScore = Math.min(99, p.fraudScore + 30);
      p.caseStatus = "UNDER_REVIEW";
      p.caseId = p.caseId || `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      // Overwrite instead of push — prevents unbounded array growth
      p.deviceRisk.signals = ["new_device_high_risk", "velocity_abuse"];
      p.deviceRisk.level = "HIGH";
      break;
    case "clear":
      p.overallRiskLevel = "LOW";
      p.fraudScore = Math.max(1, p.fraudScore - 40);
      p.caseStatus = "CLEARED";
      p.amlRiskLevel = "LOW";
      p.deviceRisk.signals = [];
      p.deviceRisk.level = "LOW";
      p.behaviorRisk.signals = [];
      p.checkpointsFailed = [];
      p.kycStatus = "APPROVED";
      break;
    case "kyc_fail":
      p.kycStatus = "REJECTED";
      p.overallRiskLevel = "HIGH";
      p.fraudScore = Math.min(99, p.fraudScore + 20);
      // Overwrite instead of push — prevents accumulation
      p.checkpointsFailed = ["kyc_enhanced"];
      break;
    case "aml_flag":
      p.amlRiskLevel = "HIGH";
      p.overallRiskLevel = "HIGH";
      p.caseStatus = "OPEN";
      p.caseId = `case-${Math.floor(Math.random() * 9000 + 1000)}`;
      break;
  }
  p.lastChecked = new Date().toISOString();
}

// ─── Webhook Delivery ──────────────────────────────────────────────────────
async function fireWebhooks(customer, eventType) {
  const payload = {
    id: uuidv4(),
    type: eventType,
    created: new Date().toISOString(),
    data: {
      customerId: customer.sardineCustomerId,
      sfAccountId: customer.sfAccountId,
      internalId: customer.id,
      riskProfile: customer.riskProfile,
    },
  };

  for (const endpoint of webhookEndpoints) {
    if (endpoint.events.includes(eventType) || endpoint.events.includes("*")) {
      try {
        await axios.post(endpoint.url, payload, { timeout: 3000 });
        console.log(`[Sardine] Webhook fired → ${endpoint.url} (${eventType})`);
      } catch (err) {
        console.log(`[Sardine] Webhook delivery failed → ${endpoint.url}: ${err.message}`);
      }
    }
  }
}

// ─── Auto-simulation: randomly change risk signals every 30s for demo ─────
let simulationIndex = 0;
const scenarios = ["escalate", "clear", "kyc_fail", "aml_flag", "clear"];
const customerIds = Object.keys(customers);

setInterval(() => {
  const customerId = customerIds[simulationIndex % customerIds.length];
  const scenario = scenarios[simulationIndex % scenarios.length];
  const customer = customers[customerId];
  console.log(`\n[Sardine] Auto-simulation: ${customer.name} → scenario '${scenario}'`);
  applyScenario(customer, scenario);
  fireWebhooks(customer, "customer.risk_updated");
  simulationIndex++;
}, 30000);

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = 3001; // Fixed internal port — do not use process.env.PORT
app.listen(PORT, () => {
  console.log(`[Sardine] Mock API running on http://localhost:${PORT}`);
  console.log(`[Sardine] Customers: ${Object.keys(customers).length} | Auto-simulation: every 30s`);
});
