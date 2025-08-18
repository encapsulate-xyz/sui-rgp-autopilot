/**
 * suiPriceHistory.js
 *
 * Helpers to fetch SUI daily price history from CoinGecko (via `coingecko-api`).
 * Exposes:
 *   - getTokenPriceHistory(tokenId, days, vsCurrency) -> [{ date, priceUsd }]
 *   - getSuiDailyPriceMap(days) -> { 'YYYY-MM-DD': price }
 */

const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();

/**
 * Fetch daily price history for a token from CoinGecko.
 * @param {string} tokenId     - CoinGecko coin id (e.g., "sui").
 * @param {number} days        - Number of days back (default 60).
 * @param {string} vsCurrency  - Quote currency (default "usd").
 * @returns {Promise<Array<{date: string, priceUsd: number}>>}
 */
async function getTokenPriceHistory(tokenId = 'sui', days = 60, vsCurrency = 'usd') {
    try {
        console.log(`[price] Fetching ${days} days of daily prices for '${tokenId}' (${vsCurrency.toUpperCase()})…`);

        const resp = await CoinGeckoClient.coins.fetchMarketChart(tokenId, {
            vs_currency: vsCurrency,
            days,
            interval: 'daily',
        });

        if (!resp || resp.success === false) {
            const msg = resp?.message || 'Unknown error from CoinGecko';
            throw new Error(msg);
        }

        const prices = resp.data?.prices;
        if (!Array.isArray(prices) || prices.length === 0) {
            console.warn('[price] No price data returned.');
            return [];
        }

        // prices is [[timestamp_ms, price], ...]
        const rows = prices.map(([ts, price]) => ({
            date: new Date(ts).toISOString().slice(0, 10), // YYYY-MM-DD (UTC)
            priceUsd: Number(price),
        }));

        console.log(`[price] Received ${rows.length} daily points.`);
        return rows;
    } catch (err) {
        console.error(`[price] Failed to fetch history for '${tokenId}': ${err.message}`);
        return [];
    }
}

/**
 * Convenience: { 'YYYY-MM-DD': priceUsd }
 * @param {number} days
 * @returns {Promise<Record<string, number>>}
 */
async function getSuiDailyPriceMap(days = 120) {
    const rows = await getTokenPriceHistory('sui', days, 'usd');
    const map = {};
    for (const r of rows) map[r.date] = r.priceUsd;
    return map;
}

module.exports = {
    getTokenPriceHistory,
    getSuiDailyPriceMap,
};