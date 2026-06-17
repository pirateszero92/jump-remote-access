// Format bytes to readable string
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatBandwidth(bytesPerSec) {
  const bits = bytesPerSec * 8;
  if (bits > 1000000) return (bits / 1000000).toFixed(2) + ' Mbps';
  if (bits > 1000) return (bits / 1000).toFixed(2) + ' Kbps';
  return bits.toFixed(0) + ' bps';
}

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_HISTORY = 20;

let charts = {};
let prevData = {}; // Store previous counters to calculate rates

async function loadDashboard() {
  const grid = document.getElementById('host-grid');
  
  try {
    const res = await fetch('/api/targets');
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      throw new Error('Failed to load targets');
    }
    const targets = await res.json();
    const monitored = targets.filter(t => t.monitorType === 'snmp' || t.monitorType === 'exporter');
    
    if (monitored.length === 0) {
      grid.innerHTML = '<div style="color: var(--text3);">No hosts configured for monitoring. Go back and edit a connection to enable SNMP or Node Exporter.</div>';
      return;
    }

    grid.innerHTML = '';
    monitored.forEach(target => {
      const id = target.id;
      const typeLabel = target.monitorType === 'snmp' ? 'SNMP' : 'Prometheus';
      
      const card = document.createElement('div');
      card.className = 'host-card';
      card.id = `card-${id}`;
      card.innerHTML = `
        <div class="hc-header">
          <div class="hc-title">${target.name || target.ip}</div>
          <div class="hc-type">${typeLabel}</div>
        </div>
        <div id="err-${id}" class="error-msg" style="display:none;"></div>
        <div class="metrics-grid" id="metrics-${id}">
          <div class="metric-box">
            <div class="mb-title">CPU Load</div>
            <div class="chart-container"><canvas id="cpuChart-${id}"></canvas></div>
            <div id="cpu-text-${id}" class="mem-text" style="margin-top:5px; font-size:14px; font-weight:bold;">-- %</div>
          </div>
          <div class="metric-box">
            <div class="mb-title">Memory Usage</div>
            <div class="mem-bar"><div id="mem-fill-${id}" class="mem-fill" style="width: 0%;"></div></div>
            <div id="mem-text-${id}" class="mem-text">-- / --</div>
          </div>
          <div class="metric-box full-width">
            <div class="mb-title">Network Bandwidth (RX/TX)</div>
            <div class="chart-container"><canvas id="netChart-${id}"></canvas></div>
            <div id="net-text-${id}" class="mem-text" style="margin-top:5px; display:flex; justify-content:center; gap:20px;">
              <span style="color:#00d4aa;"><i class="fa-solid fa-arrow-down"></i> <span id="rx-text-${id}">--</span></span>
              <span style="color:#ff4d6a;"><i class="fa-solid fa-arrow-up"></i> <span id="tx-text-${id}">--</span></span>
            </div>
          </div>
          <div class="metric-box full-width">
            <div class="mb-title">Storage Volumes</div>
            <div id="disks-${id}"></div>
          </div>
        </div>
      `;
      grid.appendChild(card);
      
      // Init Charts
      const ctxCpu = document.getElementById(`cpuChart-${id}`).getContext('2d');
      charts[`cpu-${id}`] = new Chart(ctxCpu, {
        type: 'line',
        data: {
          labels: Array(MAX_HISTORY).fill(''),
          datasets: [{
            label: 'CPU %',
            data: Array(MAX_HISTORY).fill(0),
            borderColor: '#f5a623',
            backgroundColor: 'rgba(245, 166, 35, 0.2)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { min: 0, max: 100, display: true }, x: { display: false } },
          plugins: { legend: { display: false } },
          animation: { duration: 0 }
        }
      });

      const ctxNet = document.getElementById(`netChart-${id}`).getContext('2d');
      charts[`net-${id}`] = new Chart(ctxNet, {
        type: 'line',
        data: {
          labels: Array(MAX_HISTORY).fill(''),
          datasets: [
            {
              label: 'RX',
              data: Array(MAX_HISTORY).fill(0),
              borderColor: '#00d4aa',
              borderWidth: 2,
              tension: 0.4,
              pointRadius: 0
            },
            {
              label: 'TX',
              data: Array(MAX_HISTORY).fill(0),
              borderColor: '#ff4d6a',
              borderWidth: 2,
              tension: 0.4,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, display: true }, x: { display: false } },
          plugins: { legend: { display: false } },
          animation: { duration: 0 }
        }
      });

      // Start polling for this target
      pollTarget(target);
      setInterval(() => pollTarget(target), POLL_INTERVAL);
    });

  } catch (err) {
    grid.innerHTML = `<div style="color: var(--red);">Error loading dashboard: ${err.message}</div>`;
  }
}

async function pollTarget(target) {
  const id = target.id;
  try {
    const qs = new URLSearchParams({
      host: target.ip,
      type: target.monitorType,
      community: target.monitorCommunity || '',
      port: target.monitorPort || ''
    });

    const res = await fetch(`/api/monitor/metrics?${qs}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || res.statusText);
    }
    
    const data = await res.json();
    
    document.getElementById(`err-${id}`).style.display = 'none';
    document.getElementById(`metrics-${id}`).style.opacity = '1';

    const prev = prevData[id] || { ts: Date.now() - POLL_INTERVAL };
    const now = Date.now();
    const elapsedSeconds = (now - prev.ts) / 1000;

    // CPU Calculation
    let cpuLoad = 0;
    if (data.cpu.type === 'percent') {
      cpuLoad = data.cpu.load;
    } else if (data.cpu.type === 'counters') {
      if (prev.cpu) {
        const idleDiff = data.cpu.idleCounters - prev.cpu.idleCounters;
        const totalDiff = data.cpu.totalCounters - prev.cpu.totalCounters;
        if (totalDiff > 0) {
          const idleRate = idleDiff / totalDiff;
          cpuLoad = Math.max(0, Math.min(100, (1 - idleRate) * 100));
        }
      }
    }
    
    document.getElementById(`cpu-text-${id}`).textContent = cpuLoad.toFixed(1) + ' %';
    const cpuChart = charts[`cpu-${id}`];
    cpuChart.data.datasets[0].data.shift();
    cpuChart.data.datasets[0].data.push(cpuLoad);
    cpuChart.update();

    // Memory
    if (data.memory.total > 0) {
      const memPct = (data.memory.used / data.memory.total) * 100;
      document.getElementById(`mem-fill-${id}`).style.width = memPct + '%';
      document.getElementById(`mem-text-${id}`).textContent = `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)} (${memPct.toFixed(1)}%)`;
    }

    // Network Calculation
    let totalRxBps = 0;
    let totalTxBps = 0;
    
    // Sum all interfaces
    const currentNet = { rx: 0, tx: 0 };
    data.network.forEach(iface => {
      currentNet.rx += iface.inBytes;
      currentNet.tx += iface.outBytes;
    });

    if (prev.net && elapsedSeconds > 0) {
      totalRxBps = Math.max(0, (currentNet.rx - prev.net.rx) / elapsedSeconds);
      totalTxBps = Math.max(0, (currentNet.tx - prev.net.tx) / elapsedSeconds);
    }

    document.getElementById(`rx-text-${id}`).textContent = formatBandwidth(totalRxBps);
    document.getElementById(`tx-text-${id}`).textContent = formatBandwidth(totalTxBps);
    
    const netChart = charts[`net-${id}`];
    netChart.data.datasets[0].data.shift();
    netChart.data.datasets[0].data.push(totalRxBps * 8); // Store bits
    netChart.data.datasets[1].data.shift();
    netChart.data.datasets[1].data.push(totalTxBps * 8);
    netChart.update();

    // Disks
    const disksContainer = document.getElementById(`disks-${id}`);
    disksContainer.innerHTML = data.disks.map(d => {
      const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
      return `
        <div class="disk-item">
          <div class="disk-name">
            <span>${d.name}</span>
            <span>${formatBytes(d.used)} / ${formatBytes(d.total)} (${pct.toFixed(1)}%)</span>
          </div>
          <div class="disk-bar"><div class="disk-fill" style="width: ${pct}%"></div></div>
        </div>
      `;
    }).join('');

    // Save state for next tick
    prevData[id] = {
      ts: now,
      cpu: data.cpu.type === 'counters' ? { idleCounters: data.cpu.idleCounters, totalCounters: data.cpu.totalCounters } : null,
      net: currentNet
    };

  } catch (err) {
    const errDiv = document.getElementById(`err-${id}`);
    errDiv.textContent = `Monitoring error: ${err.message}`;
    errDiv.style.display = 'block';
    document.getElementById(`metrics-${id}`).style.opacity = '0.4';
  }
}

// Start
document.addEventListener('DOMContentLoaded', loadDashboard);
