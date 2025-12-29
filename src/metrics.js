/**
 * metrics.js
 *
 * Fetch 50 epochs from Sui GraphQL and compute per-epoch metrics
 * using ONLY rollingGasSummary (ignore epochs.totalGasFees).
 *
 * Adds:
 *  - price_usd matched by epoch end date (fallback start)
 *  - avgTotalPerTx_USD, avgCompPerTx_USD
 *  - **latest epoch referenceGasPrice** in the returned payload
 *  - **exports collectMetrics()** so other scripts (RGP calc) can reuse results
 *  - optional JSON dump via METRICS_OUT_JSON
 */

const { getSuiDailyPriceMap } = require('./suiPriceHistory');
const fs = require("fs");

const ENDPOINT =
    process.env.SUI_GRAPHQL_URL ||
    'https://graphql.mainnet.sui.io/graphql';

const QUERY = `
query Epochs {
  epochs(last: 28) {
    nodes {
      epochId
      startTimestamp
      endTimestamp
      totalTransactions
      totalStakeRewards
      referenceGasPrice
      checkpoints(last: 1) {
        nodes {
          rollingGasSummary {
            computationCost
            storageCost
            storageRebate
            nonRefundableStorageFee
          }
        }
      }
    }
  }
}
`;

const MIST_PER_SUI = 1_000_000_000n;

/* ------------------------- bigint / formatting helpers ------------------------ */

function toBigIntOrNull(v) {
    if (v === null || v === undefined) return null;
    try { return BigInt(String(v)); } catch { return null; }
}

function divBigIntToDecimalString(numer, denom, decimals = 9) {
    if (denom === 0n) return 'NaN';
    const neg = (numer < 0n) ^ (denom < 0n);
    numer = numer < 0n ? -numer : numer;
    denom = denom < 0n ? -denom : denom;

    const scale = 10n ** BigInt(decimals);
    const q = (numer * scale) / denom;
    const intPart = q / scale;
    const fracPart = q % scale;
    return `${neg ? '-' : ''}${intPart.toString()}.${fracPart.toString().padStart(decimals, '0')}`;
}

function mistToSuiString(mist, decimals = 6) {
    return divBigIntToDecimalString(mist, MIST_PER_SUI, decimals);
}

function mistToSuiNumber(mist) {
    return Number(divBigIntToDecimalString(mist, MIST_PER_SUI, 9));
}

/** percent = (numer / denom) * 100, rendered with given decimals */
function percentFromBigInt(numer, denom, decimals = 2) {
    if (denom === null || denom === 0n || numer === null) return 'N/A';
    const s = divBigIntToDecimalString(numer * 100n, denom, decimals);
    return `${s}%`;
}

function averageNumbers(nums) {
    const xs = nums.filter((v) => Number.isFinite(v));
    if (!xs.length) return NaN;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isoDateOnly(s) {
    if (!s) return null;
    try { return new Date(s).toISOString().slice(0, 10); } catch { return null; }
}

/* -------------------------------- networking --------------------------------- */

async function postGraphQL(query, variables = {}) {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    return json.data;
}

/* ------------------------------- core logic ---------------------------------- */

function extractEpoch(node) {
    const {
        epochId,
        totalTransactions,
        totalStakeRewards,
        startTimestamp,
        endTimestamp,
    } = node ?? {};
    const ckNodes = node?.checkpoints?.nodes ?? [];

    if (!Array.isArray(ckNodes) || ckNodes.length === 0) {
        console.warn(`[skip] epoch ${epochId ?? '?'}: checkpoints.nodes missing/empty`);
        return null;
    }
    const r = ckNodes[0]?.rollingGasSummary;
    if (!r) {
        console.warn(`[skip] epoch ${epochId ?? '?'}: rollingGasSummary missing`);
        return null;
    }

    const comp = toBigIntOrNull(r.computationCost);
    const stor = toBigIntOrNull(r.storageCost);
    const rebate = toBigIntOrNull(r.storageRebate);
    const txCount = Number(totalTransactions ?? 0);
    const stakeRewards = toBigIntOrNull(totalStakeRewards);

    if (
        comp === null || stor === null || rebate === null ||
        !Number.isFinite(txCount) || txCount <= 0
    ) {
        console.warn(
            `[skip] epoch ${epochId ?? '?'}: invalid fields (comp=${comp}, stor=${stor}, rebate=${rebate}, tx=${txCount})`
        );
        return null;
    }

    const totalGasFee = comp + stor - rebate; // MIST
    const avgTotalPerTx = totalGasFee / BigInt(txCount);
    const avgCompPerTx  = comp / BigInt(txCount);

    const compSharePct =
        totalGasFee > 0n ? percentFromBigInt(comp, totalGasFee, 2) : 'N/A';

    const gasOverRewardsPct =
        stakeRewards && stakeRewards > 0n
            ? percentFromBigInt(totalGasFee, stakeRewards, 2)
            : 'N/A';

    return {
        epochId,
        startDate: isoDateOnly(startTimestamp),
        endDate: isoDateOnly(endTimestamp),
        txCount,
        totalGasFee,
        comp,
        avgTotalPerTx,
        avgCompPerTx,
        compSharePct,
        gasOverRewardsPct,
    };
}

function summarize(rows) {
    const r = rows.filter(Boolean);
    if (!r.length) return { rows: r, overall: null };

    const avgTx = Math.round(r.reduce((s, x) => s + x.txCount, 0) / r.length);
    const avgTotalGasPerEpoch =
        r.reduce((s, x) => s + x.totalGasFee, 0n) / BigInt(r.length);
    const avgCompPerEpoch =
        r.reduce((s, x) => s + x.comp, 0n) / BigInt(r.length);
    const avgTotalPerTxSimple =
        r.reduce((s, x) => s + x.avgTotalPerTx, 0n) / BigInt(r.length);
    const avgCompPerTxSimple =
        r.reduce((s, x) => s + x.avgCompPerTx, 0n) / BigInt(r.length);

    const pctToNum = (s) => (s === 'N/A' ? NaN : Number(s.replace('%', '')));
    const avgCompSharePct = averageNumbers(r.map((x) => pctToNum(x.compSharePct)));
    const avgGasOverRewardsPct = averageNumbers(r.map((x) => pctToNum(x.gasOverRewardsPct)));

    const avgPrice = averageNumbers(r.map((x) => (typeof x.price_usd === 'number' ? x.price_usd : NaN)));
    const avgTotalPerTxUSD = averageNumbers(
        r.map((x) => (typeof x.price_usd === 'number'
            ? mistToSuiNumber(x.avgTotalPerTx) * x.price_usd
            : NaN))
    );
    const avgCompPerTxUSD = averageNumbers(
        r.map((x) => (typeof x.price_usd === 'number'
            ? mistToSuiNumber(x.avgCompPerTx) * x.price_usd
            : NaN))
    );

    const overall = {
        epochsIncluded: r.length,
        avgTotalTransactions: avgTx,
        avgPriceUSD: Number.isFinite(avgPrice) ? avgPrice.toFixed(4) : 'N/A',
        avgTotalGasPerEpoch_SUI: mistToSuiString(avgTotalGasPerEpoch, 6),
        avgComputationPerEpoch_SUI: mistToSuiString(avgCompPerEpoch, 6),
        avgTotalCostPerTx_SUI: mistToSuiString(avgTotalPerTxSimple, 9),
        avgComputationCostPerTx_SUI: mistToSuiString(avgCompPerTxSimple, 9),
        avgTotalCostPerTx_USD: Number.isFinite(avgTotalPerTxUSD) ? avgTotalPerTxUSD.toFixed(6) : 'N/A',
        avgComputationCostPerTx_USD: Number.isFinite(avgCompPerTxUSD) ? avgCompPerTxUSD.toFixed(6) : 'N/A',
        avgCompSharePct: Number.isFinite(avgCompSharePct) ? `${avgCompSharePct.toFixed(2)}%` : 'N/A',
        avgTotalGasOverRewardsPct: Number.isFinite(avgGasOverRewardsPct)
            ? `${avgGasOverRewardsPct.toFixed(2)}%`
            : 'N/A',

        // Numeric convenience copies for programmatic use in RGP calc:
        _num: {
            avgPriceUSD: Number.isFinite(avgPrice) ? avgPrice : NaN,
            avgTotalCostPerTx_SUI: mistToSuiNumber(avgTotalPerTxSimple),
            avgComputationCostPerTx_SUI: mistToSuiNumber(avgCompPerTxSimple),
            avgTotalCostPerTx_USD: Number.isFinite(avgTotalPerTxUSD) ? avgTotalPerTxUSD : NaN,
            avgComputationCostPerTx_USD: Number.isFinite(avgCompPerTxUSD) ? avgCompPerTxUSD : NaN,
            avgCompShare: Number.isFinite(avgCompSharePct) ? avgCompSharePct / 100 : NaN, // decimal form
            avgTotalGasOverRewards: Number.isFinite(avgGasOverRewardsPct) ? avgGasOverRewardsPct / 100 : NaN,
        },
    };

    return { rows: r, overall };
}

function attachPrice(rows, priceMap) {
    return rows.map((r) => {
        const p =
            (r.endDate && priceMap[r.endDate]) ??
            (r.startDate && priceMap[r.startDate]) ??
            null;

        const priceNum = p === null ? null : Number(p);
        const avgTotalPerTx_USD =
            typeof priceNum === 'number' ? mistToSuiNumber(r.avgTotalPerTx) * priceNum : 'N/A';
        const avgCompPerTx_USD =
            typeof priceNum === 'number' ? mistToSuiNumber(r.avgCompPerTx) * priceNum : 'N/A';

        return {
            ...r,
            price_usd: priceNum === null ? 'N/A' : priceNum,
            avgTotalPerTx_USD,
            avgCompPerTx_USD,
        };
    });
}

function getLatestEpochRGP(rawNodes) {
    // Find the node with the maximum epochId that has a referenceGasPrice
    let latest = null;
    for (const n of rawNodes || []) {
        if (n?.epochId == null || n?.referenceGasPrice == null) continue;
        if (!latest || Number(n.epochId) > Number(latest.epochId)) {
            latest = n;
        }
    }
    if (!latest) return { epochId: null, referenceGasPrice: null };
    const rgpNum = Number(latest.referenceGasPrice);
    return {
        epochId: Number(latest.epochId),
        referenceGasPrice: Number.isFinite(rgpNum) ? rgpNum : null,
    };
}

/**
 * Collect metrics and return a structured payload for downstream RGP calculations.
 * If METRICS_OUT_JSON is set, also writes the payload as JSON to that path.
 */
async function collectMetrics() {
    console.log(`[info] endpoint: ${ENDPOINT}`);
    console.log('[info] fetching epochs and SUI prices…');

    // Price map first (120 days to be safe for date joins)
    const priceMap = await getSuiDailyPriceMap(120);
    console.log(`[info] loaded ${Object.keys(priceMap).length} daily SUI prices`);

    // Epochs
    let data;
    try {
        data = await postGraphQL(QUERY);
    } catch (e) {
        console.error('[error] GraphQL request failed:', e.message);
        throw e;
    }

    const nodes = data?.epochs?.nodes;
    if (!Array.isArray(nodes)) {
        const err = new Error('response missing epochs.nodes array');
        console.error('[error]', err.message);
        throw err;
    }
    console.log(`[info] received ${nodes.length} epoch node(s)`);

    const extracted = nodes.map(extractEpoch).filter(Boolean);
    console.log(`[info] usable epochs with rollingGasSummary & txCount: ${extracted.length}`);
    if (!extracted.length) {
        const err = new Error('no usable epochs — nothing to compute');
        console.error('[error]', err.message);
        throw err;
    }

    // Attach price and build display table
    const withPrice = attachPrice(extracted, priceMap);

    const perEpochTable = withPrice.map((e) => ({
        epoch: e.epochId,
        start: e.startDate,
        end: e.endDate,
        price_usd: e.price_usd,
        txCount: e.txCount,
        totalGas_SUI: mistToSuiString(e.totalGasFee, 6),
        computation_SUI: mistToSuiString(e.comp, 6),
        avgTotalPerTx_SUI: mistToSuiString(e.avgTotalPerTx, 9),
        avgCompPerTx_SUI: mistToSuiString(e.avgCompPerTx, 9),
        avgTotalPerTx_USD:
            typeof e.avgTotalPerTx_USD === 'number' ? Number(e.avgTotalPerTx_USD).toFixed(6) : 'N/A',
        avgCompPerTx_USD:
            typeof e.avgCompPerTx_USD === 'number' ? Number(e.avgCompPerTx_USD).toFixed(6) : 'N/A',
        '%comp_of_total': e.compSharePct,
        '%(totalGas / stakeRewards)': e.gasOverRewardsPct,
    }));

    const { overall } = summarize(withPrice);
    const latest = getLatestEpochRGP(nodes);

    const payload = {
        generatedAt: new Date().toISOString(),
        latestEpoch: {
            epochId: latest.epochId,
            referenceGasPrice: latest.referenceGasPrice, // MIST
        },
        perEpoch: perEpochTable,
        overall,
        // Narrow object that your RGP script can read directly:
        overallForRgp: {
            avgTotalCostPerTx_USD: overall._num.avgTotalCostPerTx_USD,          // number
            avgComputationCostPerTx_USD: overall._num.avgComputationCostPerTx_USD, // number
            avgCompShare: overall._num.avgCompShare,                            // decimal (e.g., 0.6049)
            lastEpochReferenceGasPrice: latest.referenceGasPrice,               // MIST
        },
    };

    // Optional JSON dump
    const outPath = process.env.METRICS_OUT_JSON;
    if (outPath) {
        const fs = require('fs');
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
        console.log(`[info] wrote ${outPath}`);
    }

    console.log(payload.overall);
    return payload;
}

/* ------------------------------ CLI execution -------------------------------- */

async function main() {
    const result = await collectMetrics();

    console.log('\n=== Per-epoch metrics (SUI, USD, %, + price) ===');
    console.table(result.perEpoch);

    console.log('\n=== All-epoch simple averages (excluding N/A) ===');
    console.log([result.overall]);

    console.log('\n=== Latest epoch RGP (from same query) ===');
    console.table([result.latestEpoch]);

    console.log('\n=== Overall variables for RGP calculation ===');
    console.table([result.overallForRgp]);
}

if (require.main === module) {
    main().catch((e) => {
        console.error('[fatal]', e);
        process.exit(1);
    });
}

module.exports = { collectMetrics };