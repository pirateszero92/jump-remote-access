const snmp = require('net-snmp');
const http = require('http');

// Helper to walk SNMP MIB
function walkSnmp(session, oid) {
  return new Promise((resolve, reject) => {
    const results = {};
    session.subtree(oid, (varbinds) => {
      for (const vb of varbinds) {
        if (!snmp.isVarbindError(vb)) {
          results[vb.oid.join('.')] = vb.value;
        }
      }
    }, (error) => {
      if (error) reject(error);
      else resolve(results);
    });
  });
}

// Convert Buffer to string if needed
function parseSnmpValue(val) {
  if (Buffer.isBuffer(val)) return val.toString();
  return val;
}

async function getSnmpMetrics(host, community, port) {
  const session = snmp.createSession(host, community || 'public', { port: port || 161, timeouts: [2000] });
  
  try {
    // CPU: hrProcessorLoad (1.3.6.1.2.1.25.3.3.1.2)
    const cpuWalk = await walkSnmp(session, '1.3.6.1.2.1.25.3.3.1.2');
    let cpuSum = 0, cpuCount = 0;
    for (const key in cpuWalk) {
      cpuSum += cpuWalk[key];
      cpuCount++;
    }
    const cpuLoad = cpuCount > 0 ? cpuSum / cpuCount : 0;

    // Storage: hrStorageTable (1.3.6.1.2.1.25.2.3.1)
    const storageWalk = await walkSnmp(session, '1.3.6.1.2.1.25.2.3.1');
    
    // Group storage by index
    const storageMap = {};
    for (const key in storageWalk) {
      const parts = key.split('.');
      const index = parts[parts.length - 1];
      const column = parts[parts.length - 2];
      
      if (!storageMap[index]) storageMap[index] = {};
      
      if (column === '3') storageMap[index].descr = parseSnmpValue(storageWalk[key]);
      if (column === '4') storageMap[index].units = storageWalk[key];
      if (column === '5') storageMap[index].size = storageWalk[key];
      if (column === '6') storageMap[index].used = storageWalk[key];
    }

    let memory = { total: 0, used: 0 };
    let disks = [];

    for (const idx in storageMap) {
      const s = storageMap[idx];
      if (!s.descr || !s.units || !s.size) continue;
      
      const totalBytes = s.size * s.units;
      const usedBytes = s.used * s.units;
      
      if (s.descr.toLowerCase().includes('physical memory') || s.descr.toLowerCase().includes('ram')) {
        memory = { total: totalBytes, used: usedBytes };
      } else if (s.size > 0 && (s.descr.startsWith('/') || s.descr.match(/^[A-Z]:\\/i))) {
        disks.push({ name: s.descr, total: totalBytes, used: usedBytes });
      }
    }

    // Network: ifTable (1.3.6.1.2.1.2.2.1)
    const netWalk = await walkSnmp(session, '1.3.6.1.2.1.2.2.1');
    const netMap = {};
    for (const key in netWalk) {
      const parts = key.split('.');
      const index = parts[parts.length - 1];
      const column = parts[parts.length - 2];
      
      if (!netMap[index]) netMap[index] = {};
      
      if (column === '2') netMap[index].name = parseSnmpValue(netWalk[key]);
      if (column === '10') netMap[index].inBytes = netWalk[key];
      if (column === '16') netMap[index].outBytes = netWalk[key];
    }
    
    let network = [];
    for (const idx in netMap) {
      const n = netMap[idx];
      if (n.name && n.inBytes !== undefined && n.outBytes !== undefined) {
        // Filter out loopback
        if (n.name !== 'lo' && !n.name.includes('loopback')) {
          network.push({ interface: n.name, inBytes: n.inBytes, outBytes: n.outBytes });
        }
      }
    }

    return {
      cpu: { type: 'percent', load: cpuLoad },
      memory,
      disks,
      network
    };

  } finally {
    session.close();
  }
}

function fetchPrometheusMetrics(host, port) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}:${port}/metrics`, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch metrics: ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

async function getExporterMetrics(host, port) {
  const data = await fetchPrometheusMetrics(host, port || 9100);
  const lines = data.split('\n');
  
  let cpuIdle = 0, cpuTotal = 0;
  let memTotal = 0, memAvail = 0;
  let diskMap = {};
  let netMap = {};

  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    
    // CPU
    if (line.startsWith('node_cpu_seconds_total')) {
      const val = parseFloat(line.split(' ')[1]);
      cpuTotal += val;
      if (line.includes('mode="idle"')) cpuIdle += val;
    }
    
    // Memory
    if (line.startsWith('node_memory_MemTotal_bytes ')) memTotal = parseFloat(line.split(' ')[1]);
    if (line.startsWith('node_memory_MemAvailable_bytes ')) memAvail = parseFloat(line.split(' ')[1]);
    
    // Disks
    if (line.startsWith('node_filesystem_size_bytes{') && (line.includes('fstype="ext4"') || line.includes('fstype="xfs"') || line.includes('fstype="ntfs"'))) {
      const mountpointMatch = line.match(/mountpoint="([^"]+)"/);
      if (mountpointMatch) {
        const mp = mountpointMatch[1];
        if (!diskMap[mp]) diskMap[mp] = {};
        diskMap[mp].total = parseFloat(line.split(' ')[1]);
      }
    }
    if (line.startsWith('node_filesystem_avail_bytes{') && (line.includes('fstype="ext4"') || line.includes('fstype="xfs"') || line.includes('fstype="ntfs"'))) {
      const mountpointMatch = line.match(/mountpoint="([^"]+)"/);
      if (mountpointMatch) {
        const mp = mountpointMatch[1];
        if (!diskMap[mp]) diskMap[mp] = {};
        diskMap[mp].avail = parseFloat(line.split(' ')[1]);
      }
    }

    // Network
    if (line.startsWith('node_network_receive_bytes_total{')) {
      const devMatch = line.match(/device="([^"]+)"/);
      if (devMatch && devMatch[1] !== 'lo') {
        const dev = devMatch[1];
        if (!netMap[dev]) netMap[dev] = {};
        netMap[dev].inBytes = parseFloat(line.split(' ')[1]);
      }
    }
    if (line.startsWith('node_network_transmit_bytes_total{')) {
      const devMatch = line.match(/device="([^"]+)"/);
      if (devMatch && devMatch[1] !== 'lo') {
        const dev = devMatch[1];
        if (!netMap[dev]) netMap[dev] = {};
        netMap[dev].outBytes = parseFloat(line.split(' ')[1]);
      }
    }
  }

  let disks = [];
  for (const mp in diskMap) {
    if (diskMap[mp].total && diskMap[mp].avail !== undefined) {
      disks.push({ name: mp, total: diskMap[mp].total, used: diskMap[mp].total - diskMap[mp].avail });
    }
  }

  let network = [];
  for (const dev in netMap) {
    if (netMap[dev].inBytes !== undefined && netMap[dev].outBytes !== undefined) {
      network.push({ interface: dev, inBytes: netMap[dev].inBytes, outBytes: netMap[dev].outBytes });
    }
  }

  return {
    cpu: { type: 'counters', idleCounters: cpuIdle, totalCounters: cpuTotal },
    memory: { total: memTotal, used: memTotal - memAvail },
    disks,
    network
  };
}

module.exports = {
  getSnmpMetrics,
  getExporterMetrics
};
