const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

// Pull these from the environment. In GitHub Actions, they'll be injected from your repo secrets.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Optional: Basic check to ensure they're provided
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
];

/**
 * Try to extract product details via JSON‑LD.
 */
async function scrapeJsonLD(page) {
  console.log("⏳ Searching for JSON‑LD script...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const jsonLDData = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          if (data["@type"] && data["@type"].toLowerCase().includes("product")) {
            return data;
          }
        } catch (err) {
          continue;
        }
      }
      return null;
    });
    if (jsonLDData && jsonLDData.offers) {
      const offer = Array.isArray(jsonLDData.offers) ? jsonLDData.offers[0] : jsonLDData.offers;
      console.log(`✅ JSON‑LD SCRAPED - Price: ${offer.price}, Availability: ${offer.availability}`);
      return {
        price: parseFloat(offer.price),
        availability: offer.availability.toLowerCase().includes("instock")
      };
    }
    console.log(`🔄 JSON‑LD not found, retrying... (${attempt}/3)`);
    await page.waitForTimeout(1000);
  }
  console.log("⚠️ JSON‑LD data not found.");
  return null;
}

/**
 * Fallback using common CSS selectors.
 */
async function fallbackCSS(page) {
  console.log("⏳ Trying fallback via CSS selectors...");
  try {
    const priceElement = await page.$('[data-test="price"], .price, .product-price, [itemprop="price"]');
    let price = null;
    if (priceElement) {
      const priceText = await page.evaluate(el => el.textContent.replace(/[^\d.,]/g, '').trim(), priceElement);
      price = parseFloat(priceText.replace(/\s/g, "").replace(",", "."));
    }
    const availabilityElement = await page.$('[data-test="availability"], .availability, .stock-status, [itemprop="availability"]');
    let availability = false;
    if (availabilityElement) {
      const availabilityText = await page.evaluate(el => el.textContent, availabilityElement);
      availability = availabilityText.toLowerCase().includes("in stock");
    }
    if (price !== null) {
      console.log(`✅ Fallback CSS: Price: ${price}, Availability: ${availability}`);
      return { price, availability };
    }
  } catch (error) {
    console.error("❌ Error in fallback CSS:", error);
  }
  return null;
}

/**
 * Galaxus-specific fallback: extract price and availability from meta tags.
 */
async function fallbackGalaxus(page) {
  console.log("⏳ Trying Galaxus meta fallback...");
  try {
    const metaPrice = await page.$eval('meta[property="product:price:amount"]', el => el.getAttribute("content")).catch(() => null);
    const metaAvailability = await page.$eval('meta[property="og:availability"]', el => el.getAttribute("content")).catch(() => null);
    if (metaPrice && metaAvailability) {
      const price = parseFloat(metaPrice);
      const availability = metaAvailability.toLowerCase().includes("in stock");
      console.log(`✅ Galaxus meta fallback: Price: ${price}, Availability: ${availability}`);
      return { price, availability };
    }
  } catch (error) {
    console.error("❌ Error in fallbackGalaxus:", error);
  }
  return null;
}

/**
 * Brack-specific fallback: parse the legacy utag script.
 */
async function fallbackBrack(page) {
  console.log("⏳ Trying Brack utag fallback...");
  try {
    const utagScript = await page.$('script[data-name="utag"]');
    if (utagScript) {
      const utagText = await page.evaluate(el => el.innerText, utagScript);
      // Expecting a string like: var legacy_utag_data = { ... };
      const match = utagText.match(/var\s+legacy_utag_data\s*=\s*(\{[\s\S]*\});?/);
      if (match && match[1]) {
        const utagData = JSON.parse(match[1]);
        if (utagData.prod && utagData.prod.length > 0) {
          // Here we simply take the first product entry.
          const priceStr = utagData.prod[0].price;
          const price = parseFloat(priceStr);
          // For availability, we check if stock is greater than zero.
          const availability = parseInt(utagData.prod[0].stock) > 0;
          console.log(`✅ Brack utag fallback: Price: ${price}, Availability: ${availability}`);
          return { price, availability };
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in fallbackBrack:", error);
  }
  return null;
}

/**
 * Combined fallback: try CSS selectors first; if nothing is found,
 * check the URL to decide whether to try Galaxus or Brack–specific fallbacks.
 */
async function scrapeFallback(page) {
  let result = await fallbackCSS(page);
  if (!result) {
    const url = page.url();
    if (url.includes("galaxus.ch")) {
      result = await fallbackGalaxus(page);
    } else if (url.includes("brack.ch")) {
      result = await fallbackBrack(page);
    }
  }
  if (!result) {
    console.warn("❌ No price or availability found via fallback.");
  }
  return result;
}

/**
 * Scrape a single vendor’s product page.
 */
async function scrapeVendor(url, browserInstance) {
  console.log(`🌍 Scraping: ${url}`);
  try {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const context = await browserInstance.newContext({ userAgent });
    const page = await context.newPage();

    // Block unnecessary resources for faster loading.
    await page.route('**/*', route => {
      const blockedTypes = ["image", "stylesheet", "font", "media"];
      if (blockedTypes.includes(route.request().resourceType())) {
        return route.abort();
      }
      route.continue();
    });

    // Use a generous timeout and wait for network idle.
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // Detect possible bot blocking.
    const isBlocked = await page.evaluate(() =>
      document.body.innerText.includes("You have been blocked")
    );
    if (isBlocked) {
      console.log("🚨 BLOCK DETECTED! Skipping...");
      await context.close();
      return null;
    }

    let scrapedData = await scrapeJsonLD(page);
    if (!scrapedData) {
      scrapedData = await scrapeFallback(page);
    }

    await context.close();
    return scrapedData;
  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error);
    return null;
  }
}

const MAX_CONCURRENT_SCRAPES = 5;

async function scrapeAllProducts() {
  const { data: vendors } = await supabase.from("vendors").select("*");
  const { data: vendorUrls } = await supabase.from("vendor_urls").select("*");

  if (!vendorUrls || vendorUrls.length === 0) {
    console.log("⚠️ No products found to scrape.");
    return;
  }

  console.log(`🛠️ Found ${vendorUrls.length} products to scrape.`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-http2',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  // Process products in batches.
  const scrapeQueue = vendorUrls.map(entry => async () => {
    console.log(`🟡 Processing: ${entry.url}`);
    const vendor = vendors.find(v => v.id === entry.vendor_id);
    if (!vendor) return;

    const scrapedData = await scrapeVendor(entry.url, browser);

    if (scrapedData) {
      await supabase.from("product_prices").insert({
        product_id: entry.product_id,
        vendor_id: entry.vendor_id,
        price: scrapedData.price,
        availability: scrapedData.availability,
        scraped_at: new Date().toISOString()
      });
      console.log(`✅ Updated ${entry.url} - Price: ${scrapedData.price}, Available: ${scrapedData.availability}`);
    } else {
      console.log(`🚨 Failed to scrape ${entry.url}.`);
    }
  });

  for (let i = 0; i < scrapeQueue.length; i += MAX_CONCURRENT_SCRAPES) {
    const batch = scrapeQueue.slice(i, i + MAX_CONCURRENT_SCRAPES).map(fn => fn());
    await Promise.allSettled(batch);
    console.log(`⏳ Finished a batch of ${MAX_CONCURRENT_SCRAPES} scrapes...`);
    const randomDelay = Math.floor(Math.random() * 3000) + 1000;
    console.log(`⏳ Waiting ${randomDelay / 1000}s before next batch...`);
    await new Promise(resolve => setTimeout(resolve, randomDelay));
  }

  await browser.close();
  console.log("🎯 Scraping completed.");
}

scrapeAllProducts().then(() => console.log("🎯 Scraping completed."));
