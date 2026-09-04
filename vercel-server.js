/**
 * Bulk Product Import — Vercel (Node.js Express)
 *
 * Deploy su Vercel in pochi click, senza terminale
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─────────────────────────────────────────────────────────────
// Shopify OAuth Token Management
// ─────────────────────────────────────────────────────────────

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getShopifyToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60000) return cachedToken;

  const res = await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify Auth failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 86399) * 1000;
  return cachedToken;
}

// ─────────────────────────────────────────────────────────────
// Shopify GraphQL Helper
// ─────────────────────────────────────────────────────────────

async function shopifyGraphQL(query, variables) {
  const token = await getShopifyToken();
  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query, variables: variables || {} })
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map(e => e.message).join("; "));
  }
  return body.data;
}

// ─────────────────────────────────────────────────────────────
// Claude API for AI
// ─────────────────────────────────────────────────────────────

async function generateDescription(productName, sku) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `Genera una descrizione breve e accattivante (max 150 caratteri) per questo prodotto: "${productName}" (SKU: ${sku}). Solo la descrizione, niente altro.`
      }]
    })
  });

  if (!res.ok) throw new Error("Claude API failed");
  const data = await res.json();
  return data.content[0]?.text || "Prodotto di qualità";
}

async function suggestCollection(productName, description) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: `Suggerisci una collezione Shopify per questo prodotto: "${productName}" - ${description}. Solo il nome della collezione.`
      }]
    })
  });

  if (!res.ok) throw new Error("Claude API failed");
  const data = await res.json();
  return data.content[0]?.text?.trim() || "Generale";
}

// ─────────────────────────────────────────────────────────────
// Fuzzy Matching
// ─────────────────────────────────────────────────────────────

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function isSimilarProduct(name1, name2, threshold = 3) {
  const distance = levenshteinDistance(name1.toLowerCase(), name2.toLowerCase());
  return distance <= threshold;
}

// ─────────────────────────────────────────────────────────────
// CSV Parsing
// ─────────────────────────────────────────────────────────────

function parseCSV(csvText) {
  const lines = csvText.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  const products = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim());
    const product = {};
    headers.forEach((h, idx) => {
      product[h] = values[idx] || "";
    });
    if (product["Nome Prodotto"]) products.push(product);
  }

  return products;
}

// ─────────────────────────────────────────────────────────────
// De-duplicazione
// ─────────────────────────────────────────────────────────────

function deduplicateProducts(products) {
  const groups = [];
  const processed = new Set();

  for (let i = 0; i < products.length; i++) {
    if (processed.has(i)) continue;

    const current = products[i];
    const group = [current];
    processed.add(i);

    for (let j = i + 1; j < products.length; j++) {
      if (processed.has(j)) continue;
      const next = products[j];

      if (isSimilarProduct(current["Nome Prodotto"], next["Nome Prodotto"])) {
        group.push(next);
        processed.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────

// Login
app.post("/api/login", (req, res) => {
  const { pin } = req.body;
  if (pin === process.env.APP_PIN) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "PIN non corretto" });
});

// Upload Excel
app.post("/api/upload-excel", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File mancante" });

    const csvText = req.file.buffer.toString("utf-8");
    const products = parseCSV(csvText);
    const groups = deduplicateProducts(products);

    const processed = groups.map(group => ({
      nome: group[0]["Nome Prodotto"],
      sku: group[0]["SKU"],
      colore: group[0]["Colore"],
      taglia: group[0]["Taglia"],
      quantita: parseInt(group[0]["Quantità"]) || 0,
      similari: group.length > 1 ? group.slice(1).length : 0,
      groupSize: group.length,
      allVariants: group
    }));

    res.json({ products: processed, total: processed.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate Description
app.post("/api/generate-description", async (req, res) => {
  try {
    const { productName, sku } = req.body;
    if (!productName || !sku) {
      return res.status(400).json({ error: "Parametri mancanti" });
    }
    const description = await generateDescription(productName, sku);
    res.json({ description });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Suggest Collection
app.post("/api/suggest-collection", async (req, res) => {
  try {
    const { productName, description } = req.body;
    if (!productName) {
      return res.status(400).json({ error: "Nome prodotto mancante" });
    }
    const collection = await suggestCollection(productName, description || "");
    res.json({ collection });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create Products
app.post("/api/create-products", async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products)) {
      return res.status(400).json({ error: "Products array mancante" });
    }

    const results = [];

    for (const product of products) {
      try {
        const createQuery = `
          mutation CreateProduct($input: ProductInput!) {
            productCreate(input: $input) {
              product { id title handle }
              userErrors { field message }
            }
          }
        `;

        const input = {
          title: product.title,
          bodyHtml: product.description || "Prodotto",
          productType: product.type || "Product",
          vendor: product.vendor || "Store"
        };

        const data = await shopifyGraphQL(createQuery, { input });

        if (data.productCreate.product) {
          results.push({
            success: true,
            product: product.title,
            shopifyId: data.productCreate.product.id
          });
        } else {
          results.push({
            success: false,
            product: product.title,
            errors: data.productCreate.userErrors
          });
        }
      } catch (e) {
        results.push({
          success: false,
          product: product.title,
          error: e.message
        });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Export default for Vercel
module.exports = app;

// Start server (per test locale)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});