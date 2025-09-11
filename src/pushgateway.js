// pushgateway.js
const client = require('prom-client');
require('dotenv').config();

const gateway = new client.Pushgateway(process.env.PUSHGATEWAY_URL, { timeout: 5000 });

/**
 * Push a single gauge sample to Pushgateway using ONLY metric labels.
 * Works across prom-client versions because it uses the global registry.
 *
 * @param {Object} opts
 * @param {string} opts.name   Metric name, e.g. 'sui_reference_gas_price_proposed_mist'
 * @param {string} opts.help   Help string
 * @param {Object} opts.labels Metric label values, e.g. { network:'mainnet', epoch:'882' }
 * @param {number} opts.value  Numeric metric value
 * @param {string} [opts.job='sui_rgp'] Pushgateway job name
 */
async function pushGauge({ name, help, labels = {}, value, job = 'platform' }) {
    const labelNames = Object.keys(labels);

    // Create the gauge in the global registry (version-safe)
    const gauge = new client.Gauge({ name, help, labelNames });

    // Validate and set value
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error(`Invalid value for ${name}: ${value}`);
    gauge.set(labels, v);

    // Push to:  <PUSHGATEWAY_URL>/metrics/job/<job>
    await gateway.pushAdd({ jobName: job })
        .then(() => {
            console.log(`[pushgateway] pushed ${name}=${v} labels=${JSON.stringify(labels)} job=${job} at ${new Date().toISOString()}`);
        })
        .catch((err) => {
            console.error('[pushgateway] push failed:', err?.message || err);
            throw err;
        });

    // Clean the global registry so the next push starts fresh
    client.register.clear();
}

module.exports = { pushGauge };