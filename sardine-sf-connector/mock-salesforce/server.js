/**
 * Mock Salesforce Server (port 3003)
 *
 * Simulates Salesforce REST API for Account object upserts.
 * Stores field values in memory and serves them to the demo UI.
 * Also serves the demo dashboard HTML at /
 *
 * Proxy routes forward browser requests to internal services,
 * so the UI works on Railway without hardcoded localhost URLs.
 */

const express = require("express");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Internal service URLs (server-to-server, always localhost)
const CONNECTOR_INTERNAL = "http://localhost:3002";
const SARDINE_INTERNAL   = "http://localhost:3001";

// ─── In-Memory Salesforce "Database" ──────────────────────────────────────
const accounts = {
  "0015g00000XkYzAAA1": {
    Id: "0015g00000XkYzAAA1",
    Name: "Acme Corp",
    Industry: "Financial Services",
    AnnualRevenue: 4200000,
    Phone: "+1 (555) 010-1234",
    BillingCity: "San Francisco",
    BillingState: "CA",
    AccountOwner: "Sarah Chen",
    Type: "Customer",
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
  "0015g00000XkYzAAA2": {
    Id: "0015g00000XkYzAAA2",
    Name: "Globex Financial",
    Industry: "Banking",
    AnnualRevenue: 18500000,
    Phone: "+1 (555) 020-5678",
    BillingCity: "New York",
    BillingState: "NY",
    AccountOwner: "Marcus Thompson",
    Type: "Customer",
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
  "0015g00000XkYzAAA3": {
    Id: "0015g00000XkYzAAA3",
    Name: "Initech Payments",
    Industry: "Fintech",
    AnnualRevenue: 2100000,
    Phone: "+1 (555) 030-9012",
    BillingCity: "Austin",
    BillingState: "TX",
    AccountOwner: "Priya Patel",
    Type: "Prospect",
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
};

// ─── Salesforce REST API (simulated) ──────────────────────────────────────

// PATCH /services/data/v58.0/sobjects/Account/:id — upsert fields
app.patch("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) {
    return res.status(404).json({ errorCode: "NOT_FOUND", message: "Account not found" });
  }

  const updatedFields = req.body;
  const prevRisk = account.Sardine_Risk_Level__c;

  Object.assign(account, updatedFields);

  account._updateHistory.unshift({
    timestamp: new Date().toISOString(),
    prevRisk,
    newRisk: account.Sardine_Risk_Level__c,
    fraudScore: account.Sardine_Fraud_Score__c,
  });
  if (account._updateHistory.length > 10) account._updateHistory.pop();

  console.log(`[Salesforce] PATCH Account ${req.params.id} (${account.Name}) → Risk: ${account.Sardine_Risk_Level__c}, Score: ${account.Sardine_Fraud_Score__c}`);
  res.status(204).send();
});

// GET /services/data/v58.0/sobjects/Account/:id
app.get("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ errorCode: "NOT_FOUND" });
  res.json(account);
});

// GET /api/accounts — all accounts for demo UI
app.get("/api/accounts", (req, res) => {
  res.json(Object.values(accounts));
});

// GET /api/accounts/:id
app.get("/api/accounts/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
});

// ─── Proxy routes — browser calls these, server forwards internally ────────
// Needed on Railway where localhost:3001/3002 aren't reachable from the browser

// Proxy: connector events
app.get("/proxy/connector/events", async (req, res) => {
  try {
    const r = await axios.get(`${CONNECTOR_INTERNAL}/events`, { timeout: 3000 });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Proxy: connector status
app.get("/proxy/connector/status", async (req, res) => {
  try {
    const r = await axios.get(`${CONNECTOR_INTERNAL}/status`, { timeout: 3000 });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Proxy: sardine simulate
app.post("/proxy/sardine/customers/:id/simulate", async (req, res) => {
  try {
    const r = await axios.post(
      `${SARDINE_INTERNAL}/v1/customers/${req.params.id}/simulate`,
      req.body,
      { timeout: 3000 }
    );
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`[Salesforce] Mock API + UI running on port ${PORT}`);
});
