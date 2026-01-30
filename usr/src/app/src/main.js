// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor
await Actor.init();

// Read input (schema defined in .actor/input_schema.json)
const { startUrls = ['https://wework.com/locations'], maxRequestsPerCrawl = 100 } = (await Actor.getInput()) ?? {};

// Use Apify proxy (recommended)
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        const url = request.loadedUrl ?? request.url;
        log.info('Processing', { url });

        // Enqueue likely pricing and product pages found on the site
        await enqueueLinks({
            globs: ['**/pricing**', '**/plans**', '**/membership**', '**/prices**', '**/plans/**']
        });

        // Heuristic: if the URL or page contains "pricing" or "plans", try extracting plan blocks
        const pageText = $('body').text().toLowerCase();
        if (url.toLowerCase().includes('pricing') || url.toLowerCase().includes('plans') || pageText.includes('pricing') || pageText.includes('plan')) {
            try {
                // Attempt to get a space name / site title
                const spaceName = $('meta[property="og:site_name"]').attr('content') || $('title').first().text().trim();

                // Find candidate plan containers. We look for common classes/ids and fallback to sections with "price" or "plan".
                const planContainers = $('[class*="plan"], [class*="pricing"], [id*="plan"], [id*="pricing"], section, .card').filter((i, el) => {
                    const elText = $(el).text().toLowerCase();
                    return elText.includes('price') || elText.includes('per') || elText.includes('$') || elText.includes('monthly') || elText.includes('plan');
                });

                if (planContainers.length === 0) {
                    log.debug('No obvious plan containers found; attempting generic price selectors');
                }

                // Iterate candidate containers and extract plan name, price, billing cycle and features
                planContainers.each(async (i, el) => {
                    const $el = $(el);
                    // Plan name heuristics
                    const planName = $el.find('[class*="name"], [class*="title"], h2, h3, .plan-title').first().text().trim()
                        || $el.find('h3').first().text().trim()
                        || $el.find('h2').first().text().trim();

                    // Price heuristics: look for currency symbols and numbers
                    const priceText = $el.find('[class*="price"], .price, .cost, .amount').first().text().trim()
                        || ($el.text().match(/(\$|\£|\€)\s?\d+[,\d]*(\.\d+)?/g) || ['']).shift()
                        || '';

                    // Billing cycle heuristics (monthly/yearly)
                    const billingCycle = ($el.text().match(/\b(monthly|per month|/i) ?|yearly|per year|annually/i) || ['']).shift() || '';

                    // Features: collect lists or bullet points inside the container
                    const features = [];
                    $el.find('li, .feature, .features, p').each((j, f) => {
                        const t = $(f).text().trim();
                        if (t && t.length > 3) features.push(t.replace(/\s+/g, ' '));
                    });

                    // Currency detection
                    const currencyMatch = priceText.match(/(\$|USD|EUR|€|£|GBP)/i);
                    const currency = currencyMatch ? currencyMatch[0] : '';

                    // Normalize and push
                    const plan = {
                        space_name: spaceName || '',
                        plan_name: planName || '',
                        price: priceText || '',
                        currency,
                        billing_cycle: billingCycle || '',
                        features: features.length ? features : [],
                        url,
                    };

                    log.info('Saving plan', { plan_name: plan.plan_name, price: plan.price, url });
                    await Dataset.pushData(plan);
                });

                // If nothing pushed and page has clear single price blocks, try top-level selectors
                if (planContainers.length === 0) {
                    const altPrice = $('[class*="price"], .price, .cost, .amount').first().text().trim();
                    if (altPrice) {
                        await Dataset.pushData({
                            space_name: $('meta[property="og:site_name"]').attr('content') || $('title').first().text().trim(),
                            plan_name: 'default',
                            price: altPrice,
                            currency: (altPrice.match(/(\$|USD|EUR|€|£|GBP)/i) || [''])[0] || '',
                            billing_cycle: '',
                            features: [],
                            url,
                        });
                        log.info('Saved fallback price', { altPrice, url });
                    }
                }
            } catch (err) {
                log.warning('Extraction error', { url, message: err.message });
            }
        } else {
            log.debug('Page does not look like a pricing page; skipping extraction', { url });
        }
    },
});

await crawler.run(startUrls);

await Actor.exit();
