/**
 * mainnet.js
 *
 * Mainnet runner that:
 *  1) Computes a proposed new RGP via computeRgp()
 *  2) Prints **details table + summary lines**
 *  3) Pushes Prometheus metrics
 *  4) Optionally updates on-chain
 *
 * The **inputs table** is now printed inside computeRgp().
 */

require('dotenv').config();
const cron = require('node-cron');

const { computeRgp } = require('./src/computeRgp');
const { updateGasPrice } = require('./src/updateGasPrice');
const { pushGauge } = require('./src/pushgateway');

// ---------- tiny env helpers ----------
function bool(name, def = false) {
    const v = (process.env[name] || '').toLowerCase().trim();
    if (['1','true','yes','on'].includes(v)) return true;
    if (['0','false','no','off'].includes(v)) return false;
    return def;
}
function req(name) {
    const v = process.env[name];
    if (!v || v.trim() === '') throw new Error(`Missing required env: ${name}`);
    return v;
}
function opt(name, def = undefined) {
    const v = process.env[name];
    return v === undefined ? def : v;
}

// ---------- main work ----------
async function runOnceMainnet() {
    console.log('[mainnet] starting RGP computation…');

    const result = await computeRgp();
    const proposed = result?.proposedRgpMist;

    if (!Number.isFinite(proposed) || proposed <= 0) {
        throw new Error('Proposed RGP is invalid.');
    }

    // DETAILS table (kept here)
    console.log('\n=== RGP Calculation Details ===');
    console.table([{
        R_raw: result.calc.R_raw,
        clampMin: result.calc.clampMin,
        clampMax: result.calc.clampMax,
        R_clamped: result.calc.R_clamped,
        jitter: result.calc.jitter,
        R_final: result.calc.R_final,
    }]);

    // Summary lines
    console.log('\n[mainnet] Proposed RGP (MIST):', proposed);
    console.log('[mainnet] Current RGP (MIST):', result.inputs.currentRgp);
    console.log('[mainnet] Scale factor k:', result.calc.k);
    console.log('[mainnet] Guard rails enabled:', result.inputs.guardRailsEnabled,
        'range:', (result.calc.clampMin != null || result.calc.clampMax != null)
            ? [result.calc.clampMin, result.calc.clampMax] : null);

    // Push metrics to Pushgateway
    const labels = {
        project: 'sui',
        env: 'mainnet',
        type: 'ui',
        subtype: 'rgp',
    };
    try {
        await pushGauge({
            name: 'sui_reference_gas_price_proposed_mist',
            help: 'Proposed reference gas price (MIST)',
            labels,
            value: proposed,
            job: 'platform',
        });
        await pushGauge({
            name: 'sui_reference_gas_price_current_mist',
            help: 'Current reference gas price at time of proposal (MIST)',
            labels,
            value: result.inputs.currentRgp,
            job: 'platform',
        });
    } catch (e) {
        console.error('[pushgateway] push failed:', e?.message || e);
    }

    // Respect DRY_RUN / UPDATE_ONCHAIN
    const DRY_RUN = bool('DRY_RUN', false);
    const UPDATE_ONCHAIN = bool('UPDATE_ONCHAIN', false);

    if (DRY_RUN) {
        console.log('[mainnet] DRY_RUN=true → not sending any on-chain tx.');
        return { proposedRgpMist: proposed, dryRun: true };
    }

    if (!UPDATE_ONCHAIN) {
        console.log('[mainnet] UPDATE_ONCHAIN=false → returning proposed value only.');
        return { proposedRgpMist: proposed, dryRun: false };
    }

    // Update on-chain
    const network = 'mainnet';
    const rpc = req('MAINNET_RPC_URL');
    const privateKey = req('MAINNET_OPERATION_PRIVATE_KEY');
    const opCapId = req('MAINNET_OPERATION_CAP_ID');
    const gasBudget = req('MAINNET_GAS_BUDGET');

    console.log('[mainnet] Submitting on-chain update…');
    const ok = await updateGasPrice(network, rpc, privateKey, opCapId, gasBudget, proposed);

    if (ok) {
        console.log('[mainnet] ✅ RGP updated on-chain to', proposed, 'MIST');
    } else {
        console.log('[mainnet] ❌ updateGasPrice returned false; no on-chain update performed.');
    }

    return { proposedRgpMist: proposed, updatedOnChain: !!ok };
}

// ---------- CLI / Scheduler ----------
async function start() {
    const CRON_ENABLED = bool('CRON_ENABLED', true);
    const schedule = opt('CRON_SCHEDULE', '30 18 * * *'); // 16:55 UTC daily

    if (CRON_ENABLED) {
        console.log('[mainnet] Cron enabled. Schedule:', schedule, '(UTC)');
        cron.schedule(schedule, () => {
            runOnceMainnet().catch((e) => {
                console.error('[mainnet] run error:', e.message);
            });
        });
    } else {
        console.log('[mainnet] Cron disabled → running once now.');
        try {
            await runOnceMainnet();
        } catch (e) {
            console.error('[mainnet] run error:', e.message);
            process.exit(1);
        }
    }
}

if (require.main === module) {
    start();
}

module.exports = { runOnceMainnet };