'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const STORE = process.env.SHOPIFY_BETORI_STORE;
const TOKEN = process.env.SHOPIFY_BETORI_TOKEN;

if (!STORE || !TOKEN) {
  console.error('ERROR: SHOPIFY_BETORI_STORE and SHOPIFY_BETORI_TOKEN must be set');
  process.exit(1);
}

const API_BASE = `https://${STORE}.myshopify.com/admin/api/2024-01`;

const CATEGORIES = {
  'Черевики': 1,
  'Угги': 2,
  'Кросівки': 3,
  'Балетки': 4,
  'Босоніжки': 5,
  'Ботфорти': 6,
  'Лофери': 7,
  'Слайдери': 8,
  'Мокасини': 9,
  'Туфлі': 10,
  'Чоботи': 11,
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-Shopify-Access-Token': TOKEN } }, (res) => {
      if (res.statusCode === 429) {
        const wait = parseInt(res.headers['retry-after'] || '2', 10) * 1000;
        res.resume();
        console.log(`Rate limited, waiting ${wait}ms...`);
        setTimeout(() => get(url).then(resolve, reject), wait);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function fetchAllProducts() {
  const products = [];
  let url = `${API_BASE}/products.json?status=active&limit=250&fields=id,title,body_html,product_type,images,handle,variants`;
  while (url) {
    const { body, headers } = await get(url);
    const data = JSON.parse(body);
    products.push(...(data.products || []));
    url = parseNextLink(headers['link']);
    if (url) console.log('Fetching next page...');
  }
  return products;
}

function stripHtml(html) {
  if (!html) return '';
  // Remove HTML tables entirely (size tables are often in <table> tags)
  let text = html.replace(/<table[\s\S]*?<\/table>/gi, '');
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Remove size table text (plain-text variant): from "Розмірна таблиця" to end
  text = text.replace(/Розмірна таблиця[\s\S]*/i, '');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encodeHandle(handle) {
  // URL-encode non-ASCII characters (Cyrillic etc.), keep ASCII as-is
  return handle.replace(/[^\x00-\x7F]+/g, m => encodeURIComponent(m));
}

function nowWarsaw() {
  const d = new Date();
  const str = d.toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' });
  // sv-SE gives "YYYY-MM-DD HH:MM:SS", trim the seconds
  return str.slice(0, 16);
}

async function main() {
  console.log('Fetching active products from Shopify...');
  const products = await fetchAllProducts();
  console.log(`Fetched ${products.length} products`);

  const offerBlocks = [];
  let variantCount = 0;

  for (const p of products) {
    const catId = CATEGORIES[p.product_type];
    if (!catId) {
      console.warn(`WARNING: product_type "${p.product_type}" not in category list — "${p.title}" (id ${p.id}), omitting categoryId`);
    }
    const images = (p.images || []).map(i => i.src);
    const desc = stripHtml(p.body_html);
    const encodedHandle = encodeHandle(p.handle);

    for (const v of p.variants) {
      variantCount++;
      const available = (v.inventory_quantity || 0) > 0 ? 'true' : 'false';
      const stock = Math.max(0, v.inventory_quantity || 0);
      const price = parseFloat(v.price || 0).toFixed(2);
      const nameVal = escapeXml(`${p.title} розмір ${v.option1}`);
      const sizeVal = escapeXml(v.option1 || '');

      const lines = [
        `      <offer id="${v.id}" available="${available}">`,
        `        <url>https://betoristore.com.ua/products/${encodedHandle}</url>`,
        `        <price>${price}</price>`,
        `        <currencyId>UAH</currencyId>`,
      ];
      if (catId) lines.push(`        <categoryId>${catId}</categoryId>`);
      for (const src of images) {
        lines.push(`        <picture>${escapeXml(src)}</picture>`);
      }
      lines.push(
        `        <vendor>BETORI</vendor>`,
        `        <article>${escapeXml(v.sku || '')}</article>`,
        `        <stock_quantity>${stock}</stock_quantity>`,
        `        <name_ua>${nameVal}</name_ua>`,
        `        <name>${nameVal}</name>`,
        `        <description_ua><![CDATA[${desc}]]></description_ua>`,
        `        <description><![CDATA[${desc}]]></description>`,
        `        <param name="Розмір">${sizeVal}</param>`,
        `      </offer>`,
      );
      offerBlocks.push(lines.join('\n'));
    }
  }

  const date = nowWarsaw();
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<yml_catalog date="${date}">`,
    '  <shop>',
    '    <name>BETORI</name>',
    '    <company>BETORI Store</company>',
    '    <url>https://betoristore.com.ua/</url>',
    '    <currencies>',
    '      <currency id="UAH" rate="1"/>',
    '    </currencies>',
    '    <categories>',
    '      <category id="1">Черевики</category>',
    '      <category id="2">Угги</category>',
    '      <category id="3">Кросівки</category>',
    '      <category id="4">Балетки</category>',
    '      <category id="5">Босоніжки</category>',
    '      <category id="6">Ботфорти</category>',
    '      <category id="7">Лофери</category>',
    '      <category id="8">Слайдери</category>',
    '      <category id="9">Мокасини</category>',
    '      <category id="10">Туфлі</category>',
    '      <category id="11">Чоботи</category>',
    '    </categories>',
    '    <offers>',
    offerBlocks.join('\n'),
    '    </offers>',
    '  </shop>',
    '</yml_catalog>',
    '',
  ].join('\n');

  const outPath = path.join(__dirname, 'betori-rozetka.xml');
  fs.writeFileSync(outPath, xml, 'utf8');

  const offerCount = offerBlocks.length;
  console.log(`Товарів: ${products.length}, варіантів: ${variantCount}, offers у XML: ${offerCount}`);

  if (variantCount !== offerCount) {
    console.error(`ERROR: count mismatch! variants=${variantCount}, offers=${offerCount}`);
    process.exit(1);
  }

  console.log(`DONE: generate-rozetka-feed.js written, feed pushed, offers=${offerCount}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
