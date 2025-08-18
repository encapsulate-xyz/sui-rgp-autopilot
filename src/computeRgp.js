/**
 * src/computeRgp.js
 *
 * Computes a proposed new RGP (referenceGasPrice, in MIST) using:
 *   R_raw = R_now * ( (p * T_target) / C_cur )
 *
 * Jitter rules (env-driven via RGP_JITTER_RANGE='[5,5]'):
 *   - Not at clamp: random integer in [-baseLow, +baseHigh], intersected with clamp band
 *   - At MIN clamp: random integer in [0, +baseHigh]
 *   - At MAX clamp: random integer in [-baseLow, 0]
 *
 * NOTE: This function prints the **Inputs table BEFORE** running the calculation.
 * It does NOT push metrics or perform on-chain updates.
 */

require('dotenv').config();
const { collectMetrics } = require('./metrics');

/* ----------------------------- helpers ----------------------------- */

function parseNumberEnv(name, def = undefined) {
    const v = process.env[name];
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function parseBoolEnv(name, def = false) {
    const v = (process.env[name] || '').toLowerCase().trim();
    if (['1','true','yes','on'].includes(v)) return true;
    if (['0','false','no','off'].includes(v)) return false;
    return def;
}

function parseGuardRailsEnv(name = 'RGP_GUARD_RAILS', def = [-40, 40]) {
    try {
        const raw = process.env[name];
        if (!raw) return def;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length !== 2) return def;
        const low = Number(arr[0]);
        const high = Number(arr[1]);
        if (!Number.isFinite(low) || !Number.isFinite(high)) return def;
        return [low, high];
    } catch {
        return def;
    }
}

/** Parse jitter base magnitudes (non-negative ints) from env JSON, default [-5,5]. */
function parseJitterRangeEnv(name = 'RGP_JITTER_RANGE', def = [-5, 5]) {
    try {
        const raw = process.env[name];
        if (!raw) return def;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || arr.length !== 2) return def;
        let a = Math.max(0, Math.floor(Number(arr[0]))); // baseLow magnitude
        let b = Math.max(0, Math.floor(Number(arr[1]))); // baseHigh magnitude
        if (!Number.isFinite(a) || !Number.isFinite(b)) return def;
        return [a, b];
    } catch {
        return def;
    }
}

function roundToStep(x, step = 10) {
    if (!Number.isFinite(x) || step <= 0) return x;
    return Math.round(x / step) * step;
}

function clamp(x, lo, hi) {
    if (lo !== undefined && x < lo) return lo;
    if (hi !== undefined && x > hi) return hi;
    return x;
}

/* ----------------------------- core computation ----------------------------- */

function computeNewRgpFromInputs(targetAvgTxUsd, compShare, compCostUsd, currentRgp, options) {
    if (!Number.isFinite(targetAvgTxUsd) || targetAvgTxUsd <= 0) {
        throw new Error('Invalid TARGET_AVG_TX_USD (must be a positive number)');
    }
    if (!Number.isFinite(compShare) || compShare <= 0 || compShare > 1) {
        throw new Error('Invalid avgCompShare (must be in (0,1])');
    }
    if (!Number.isFinite(compCostUsd) || compCostUsd <= 0) {
        throw new Error('Invalid avgComputationCostPerTx_USD (must be > 0)');
    }
    if (!Number.isFinite(currentRgp) || currentRgp <= 0) {
        throw new Error('Invalid current RGP (must be > 0)');
    }

    const { guardRailsEnabled, guardRailsPct, roundStep, minRgpMist, maxRgpMist, jitterRange } = options;

    const C_target = compShare * targetAvgTxUsd;    // desired computation USD
    const k = C_target / compCostUsd;               // scale factor
    const R_raw = currentRgp * k;                   // raw proposed RGP

    // Guard rails (relative to current RGP):
    let clampMin = null, clampMax = null;
    if (guardRailsEnabled) {
        const lowPct = guardRailsPct?.[0] ?? -20;
        const highPct = guardRailsPct?.[1] ?? 40;
        clampMin = currentRgp * (1 + lowPct / 100);
        clampMax = currentRgp * (1 + highPct / 100);
    }

    // Apply relative rails
    const R_clamped = clamp(R_raw, clampMin, clampMax);

    // Choose jitter from env base magnitudes
    const [baseLow, baseHigh] = jitterRange || [5, 5];
    const drawn = chooseJitter(R_clamped, clampMin, clampMax, baseLow, baseHigh);

    // Apply jitter → round → absolute min/max
    let R_afterJitter = R_clamped + drawn;
    let R_final = roundToStep(R_afterJitter, roundStep);
    if (Number.isFinite(minRgpMist)) R_final = Math.max(R_final, minRgpMist);
    if (Number.isFinite(maxRgpMist)) R_final = Math.min(R_final, maxRgpMist);
    R_final = Math.max(1, Math.round(R_final));

    return {
        inputs: {
            targetAvgTxUsd,
            compShare,
            compCostUsd,
            currentRgp,
            guardRailsEnabled: !!guardRailsEnabled,
            guardRailsPct: guardRailsPct ?? [-20, 40],
            roundStep: Number.isFinite(roundStep) && roundStep > 0 ? roundStep : 10,
            minRgpMist: Number.isFinite(minRgpMist) ? minRgpMist : null,
            maxRgpMist: Number.isFinite(maxRgpMist) ? maxRgpMist : null,
            jitterRange: [baseLow, baseHigh],
        },
        calc: {
            C_target,
            k,
            R_raw,
            clampMin,
            clampMax,
            R_clamped,
            jitter: drawn,
            R_final,
        },
        proposedRgpMist: R_final,
    };
}

/**
 * Choose jitter based on clamp state and base magnitudes.
 *   baseLow, baseHigh are non-negative integers (e.g., [5,5]).
 */
function chooseJitter(R_clamped, clampMin, clampMax, baseLow, baseHigh) {
    const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

    // No rails → full base range
    if (clampMin == null || clampMax == null) {
        return randInt(-baseLow, +baseHigh);
    }

    // At min clamp → only non-negative
    if (Number.isFinite(clampMin) && R_clamped === clampMin) {
        return randInt(0, +baseHigh);
    }

    // At max clamp → only non-positive
    if (Number.isFinite(clampMax) && R_clamped === clampMax) {
        return randInt(-baseLow, 0);
    }

    // Inside band → intersect with clamp room
    const lowRoom  = Math.ceil(clampMin - R_clamped);   // min jitter to stay >= clampMin
    const highRoom = Math.floor(clampMax - R_clamped);  // max jitter to stay <= clampMax
    const lo = Math.max(-baseLow, lowRoom);
    const hi = Math.min(+baseHigh, highRoom);
    if (lo > hi) return 0;
    return randInt(lo, hi);
}

/* ----------------------------- top-level API ----------------------------- */

async function computeRgp() {
    // 1) Load metrics
    const payload = await collectMetrics();
    const o = payload?.overallForRgp || {};
    const currentRgp = o.lastEpochReferenceGasPrice;
    const compShare = o.avgCompShare;
    const compCostUsd = o.avgComputationCostPerTx_USD;
    const epoch = payload?.latestEpoch?.epochId ?? null;

    // 2) Read env config
    const targetAvgTxUsd    = parseNumberEnv('TARGET_AVG_TX_USD', NaN); // REQUIRED
    const guardRailsEnabled = parseBoolEnv('RGP_GUARD_RAILS_ENABLED', true);
    const guardRailsPct     = parseGuardRailsEnv('RGP_GUARD_RAILS', [-40, 40]);
    const roundStep         = parseNumberEnv('RGP_ROUND_STEP', 1);
    const minRgpMist        = parseNumberEnv('RGP_MIN_MIST', undefined);
    const maxRgpMist        = parseNumberEnv('RGP_MAX_MIST', undefined);
    const jitterRange       = parseJitterRangeEnv('RGP_JITTER_RANGE', [-10,10]);

    // 3) Build the INPUTS object and print it BEFORE calculation
    const preInputs = {
        epoch: epoch ?? 'unknown',
        targetAvgTxUsd,
        compShare,
        compCostUsd,
        currentRgp,
        guardRailsEnabled,
        guardRailsPct,
        roundStep,
        minRgpMist: Number.isFinite(minRgpMist) ? minRgpMist : null,
        maxRgpMist: Number.isFinite(maxRgpMist) ? maxRgpMist : null,
        jitterRange,
    };

    console.log('\n=== RGP Calculation Inputs ===');
    console.table([{
        epoch: preInputs.epoch,
        targetAvgTxUsd: preInputs.targetAvgTxUsd,
        compShare: preInputs.compShare,
        compCostUsd: preInputs.compCostUsd,
        currentRgp: preInputs.currentRgp,
        guardRailsEnabled: preInputs.guardRailsEnabled,
        guardRailsPct: JSON.stringify(preInputs.guardRailsPct),
        roundStep: preInputs.roundStep,
        minRgpMist: preInputs.minRgpMist,
        maxRgpMist: preInputs.maxRgpMist,
        jitterRange: JSON.stringify(preInputs.jitterRange),
    }]);

    // 4) Run the calculation
    const result = computeNewRgpFromInputs(
        preInputs.targetAvgTxUsd,
        preInputs.compShare,
        preInputs.compCostUsd,
        preInputs.currentRgp,
        {
            guardRailsEnabled: preInputs.guardRailsEnabled,
            guardRailsPct: preInputs.guardRailsPct,
            roundStep: preInputs.roundStep,
            minRgpMist: preInputs.minRgpMist ?? undefined,
            maxRgpMist: preInputs.maxRgpMist ?? undefined,
            jitterRange: preInputs.jitterRange,
        }
    );

    // 5) Return results
    return {
        epoch,
        proposedRgpMist: result.proposedRgpMist,
        inputs: result.inputs,
        calc: result.calc,
    };
}

module.exports = {
    computeRgp,
    computeNewRgpFromInputs,
};