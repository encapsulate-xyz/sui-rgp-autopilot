// pushgateway.js
const client = require('prom-client');
require('dotenv').config();

const gateway = new client.Pushgateway(process.env.PUSHGATEWAY_URL, {timeout: 5000});

/**
 * Push a single gauge sample to Pushgateway.
 * Prometheus will record the sample at scrape time (no need to send timestamps).
 *
 * @param {Object} opts
 * @param {string} opts.name        metric name, e.g. 'sui_reference_gas_price'
 * @param {string} opts.help        metric help string
 * @param {Object} opts.labels      label values, eg { network:'mainnet', validator:'val-01', epoch:'856' }
 * @param {number} opts.value       numeric metric value (e.g., 500 for 500 MIST)
 * @param {string} [opts.job='sui_rgp']  pushgateway job name
 * @param {Object} [opts.groupings] pushgateway groupings (e.g., { instance: 'val-01' })
 */
async function pushGauge({name, help, labels, value, job = 'sui_rgp', groupings = {}}) {
    // Build a private registry per push to avoid global state
    const registry = new client.Registry();

    const labelNames = Object.keys(labels || {});
    const gauge = new client.Gauge({
        name,
        help,
        labelNames,
        registers: [registry],
    });

    // Set the value with labels. DO NOT pass a timestamp here.
    gauge.set(labels || {}, Number(value));

    // Push (add) to pushgateway under a job and optional groupings (e.g., instance)
    await gateway.pushAdd({jobName: job, groupings}, registry)
        .then(() => {
            console.log(`[pushgateway] pushed ${name}=${value} with labels ${JSON.stringify(labels)} at ${new Date().toISOString()}`);
        })
        .catch((err) => {
            console.error('[pushgateway] push failed:', err.message || err);
            throw err;
        });
}

module.exports = {pushGauge};