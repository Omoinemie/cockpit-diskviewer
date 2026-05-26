// Main application - Cockpit Disk Viewer
(function() {
    'use strict';

    // ==================== i18n (loaded from JSON via fetch) ====================
    var i18nData = {};
    var currentLang = 'zh-CN';

    function t(key, params) {
        var str = (i18nData[currentLang] && i18nData[currentLang][key]) || key;
        if (params) {
            for (var k in params) {
                str = str.replace('{{' + k + '}}', params[k]);
            }
        }
        return str;
    }

    function loadLang(lang) {
        return fetch('static/lang/' + lang + '.json')
            .then(function(resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            })
            .then(function(data) {
                i18nData[lang] = data;
            })
            .catch(function(err) {
                console.warn('Failed to load lang ' + lang + ':', err);
                // Fallback: if zh-CN fails, try inline minimal
                if (!i18nData[lang]) i18nData[lang] = {};
            });
    }

    function updateAllI18n() {
        document.querySelectorAll('[data-i18n]').forEach(function(el) {
            var key = el.getAttribute('data-i18n');
            if (el.tagName === 'OPTION') el.textContent = t(key);
            else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = t(key);
            else el.textContent = t(key);
        });
    }

    // ==================== Menu ====================
    var menuItems = [
        { id: 'dashboard', icon: 'grid', labelKey: 'menuDashboard', section: 'main' },
        { id: 'diskinfo', icon: 'harddrive', labelKey: 'menuDiskInfo', section: 'main' },
        { id: 'smart', icon: 'heart', labelKey: 'menuSmart', section: 'main' },
        { id: 'hibernation', icon: 'moon', labelKey: 'menuHibernation', section: 'tools' },
        { id: 'iomonitor', icon: 'activity', labelKey: 'menuIoMonitor', section: 'tools' },
        { id: 'selftest', icon: 'zap', labelKey: 'menuSelfTest', section: 'tools' }
    ];

    var menuIcons = {
        grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
        harddrive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>',
        heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
        moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
        activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
        zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
    };

    var sectionLabels = { main: 'menuSectionMain', tools: 'menuSectionTools' };

    // ==================== State ====================
    var CONFIG_DIR = '/etc/cockpit/diskviewer';
    var SETTINGS_FILE = CONFIG_DIR + '/setting.json';
    var DATA_FILE = CONFIG_DIR + '/data.json';
    var state = {
        theme: 'light', menuLayout: 'side', accentColor: '#4f6ef7',
        sidebarOpen: true, refreshInterval: 5, selectedDisk: ''
    };
    var appData = { standbySince: {}, diskCache: {} };
    // standbySince: { '/dev/sda': 1716460000000 }
    // diskCache: { '/dev/sda': { info: {...}, smartAttrs: [...], health: 'passed', temp: 33, errors: {count:0}, lastUpdate: 1716460000000 } }
    
    // Hibernation history state
    var hibHistorySortAsc = false; // 默认倒序（最新在前）
    var hibHistoryLiveTimer = null; // 实时刷新定时器
    
    // 编辑状态标记（防止刷新覆盖用户修改）
    var apmEditing = false;
    var cacheEditing = false;

    // File I/O helpers (cockpit.file with superuser)
    function readJsonFile(path) {
        return new Promise(function(resolve) {
            cockpit.file(path, { superuser: 'try' }).read()
                .done(function(content) {
                    try { resolve(content ? JSON.parse(content) : null); }
                    catch(e) { resolve(null); }
                })
                .fail(function() { resolve(null); });
        });
    }
    function writeJsonFile(path, data) {
        return new Promise(function(resolve) {
            cockpit.file(path, { superuser: 'try' }).replace(JSON.stringify(data, null, 2))
                .done(function() { resolve(true); })
                .fail(function() { resolve(false); });
        });
    }
    function ensureConfigDir() {
        return runCmd(['mkdir', '-p', CONFIG_DIR]);
    }

    function loadState() {
        return readJsonFile(SETTINGS_FILE).then(function(s) {
            if (s) { for (var k in s) state[k] = s[k]; }
            return state;
        });
    }
    function saveState() { writeJsonFile(SETTINGS_FILE, state); }
    function loadData() {
        return readJsonFile(DATA_FILE).then(function(d) {
            if (d) { for (var k in d) appData[k] = d[k]; }
            return appData;
        });
    }
    // 从文件读取后端维护的字段（避免被 saveData 覆盖）
    function loadBackendData() {
        return readJsonFile(DATA_FILE).then(function(d) {
            return d || {};
        });
    }
    function saveData() {
        // 只写前端管理的字段，standbySince 由后端维护
        readJsonFile(DATA_FILE).then(function(existing) {
            var toSave = existing || {};
            toSave.diskCache = appData.diskCache || {};
            writeJsonFile(DATA_FILE, toSave);
        });
    }

    // ==================== Disk Cache ====================
    function isDiskStandby(device) {
        return !!(backendDataCache.standbySince && backendDataCache.standbySince[device]);
    }
    function getCachedDisk(device) {
        return (appData.diskCache && appData.diskCache[device]) || null;
    }
    function setCachedDisk(device, data) {
        if (!appData.diskCache) appData.diskCache = {};
        var existing = appData.diskCache[device] || {};
        for (var k in data) { if (data[k] !== undefined && data[k] !== null) existing[k] = data[k]; }
        existing.lastUpdate = Date.now();
        appData.diskCache[device] = existing;
        saveData();
    }
    // 带缓存的数据获取：休眠盘用缓存，活动盘实时获取
    // 重要：休眠盘如果没有缓存，返回 null 而不是唤醒硬盘
    function cachedQuery(device, cacheKey, fetchFn) {
        if (isDiskStandby(device)) {
            var cached = getCachedDisk(device);
            if (cached && cached[cacheKey] !== undefined) {
                return Promise.resolve(cached[cacheKey]);
            }
            // 休眠盘没有缓存，返回 null，不唤醒硬盘
            return Promise.resolve(null);
        }
        return fetchFn().then(function(val) {
            var patch = {}; patch[cacheKey] = val;
            setCachedDisk(device, patch);
            return val;
        });
    }

    // ==================== DOM ====================
    var $html, $body, $sidebar, $sidebarOverlay, $sidebarNav, $topMenuBar;
    var $hamburgerBtn, $settingsOverlay, $toastContainer;
    var $themeIconSun, $themeIconMoon;
    var currentTheme, accentColor, sidebarOpen, mobileSidebarOpen = false, selectedDisk;
    var refreshTimer = null, ioUpdateHandler = null;
    var backendDataCache = { activeSince: {}, standbySince: {} };
    function refreshBackendCache() {
        return readJsonFile(DATA_FILE).then(function(d) {
            if (d) {
                backendDataCache.activeSince = d.activeSince || {};
                backendDataCache.standbySince = d.standbySince || {};
                backendDataCache.stateHistory = d.stateHistory || [];
            }
            return backendDataCache;
        });
    }

    // ==================== Toast ====================
    var toastIcons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    function showToast(message, type, duration) {
        type = type || 'info'; duration = duration || 4;
        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.innerHTML = '<span class="toast-icon">' + (toastIcons[type] || toastIcons.info) + '</span>' +
            '<span class="toast-body">' + escapeHtml(message) + '</span>' +
            '<button class="toast-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
        toast.querySelector('.toast-close').addEventListener('click', function() { removeToast(toast); });
        toast.addEventListener('click', function(e) { if (e.target === toast || e.target.classList.contains('toast-body')) removeToast(toast); });
        $toastContainer.appendChild(toast);
        var toasts = $toastContainer.querySelectorAll('.toast');
        if (toasts.length > 5) removeToast(toasts[0]);
        toast._timer = setTimeout(function() { removeToast(toast); }, duration * 1000);
    }
    function removeToast(toast) {
        if (toast._removing) return; toast._removing = true; clearTimeout(toast._timer);
        toast.classList.add('removing');
        toast.addEventListener('animationend', function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, { once: true });
        setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 400);
    }

    // ==================== Helpers ====================
    function escapeHtml(s) { if (!s) return ''; var d = document.createElement('div'); d.appendChild(document.createTextNode(s)); return d.innerHTML; }
    function formatHours(h) {
        h = parseInt(h); if (isNaN(h) || h <= 0) return '-';
        var days = Math.floor(h / 24); var remainH = h % 24;
        var years = Math.floor(days / 365); days = days % 365;
        var months = Math.floor(days / 30); days = days % 30;
        var parts = [];
        if (years > 0) parts.push(years + ' 年');
        if (months > 0) parts.push(months + ' 月');
        if (days > 0) parts.push(days + ' 日');
        if (parts.length === 0) parts.push(remainH + ' 小时');
        return parts.join(' ') + ' (' + h + ' h)';
    }
    function formatDuration(ms) {
        if (ms < 0) ms = 0;
        var totalSec = Math.floor(ms / 1000);
        var sec = totalSec % 60;
        var totalMin = Math.floor(totalSec / 60);
        var min = totalMin % 60;
        var totalH = Math.floor(totalMin / 60);
        var h = totalH % 24;
        var days = Math.floor(totalH / 24);
        var parts = [];
        if (days > 0) parts.push(days + ' 天');
        if (h > 0) parts.push(h + ' 小时');
        if (min > 0) parts.push(min + ' 分钟');
        if (parts.length === 0) parts.push(sec + ' 秒');
        return parts.join(' ');
    }
    function runCmd(args, opts) {
        // Always resolves: returns data on success, {_error: ex} on failure
        return new Promise(function(resolve) {
            cockpit.spawn(args, opts || { superuser: 'try', err: 'out' })
                .done(function(d) { resolve(d); })
                .fail(function(ex) { resolve({ _error: ex }); });
        });
    }
    function cmdOk(result) { return !(result && typeof result === 'object' && result._error !== undefined); }
    function cmdErr(result) { return result && typeof result === 'object' && result._error ? result._error : null; }
    // Helper: runCmdThen(args, okFn, failFn) - always resolves
    function cmdThen(args, opts, okFn, failFn) {
        if (typeof opts === 'function') { failFn = okFn; okFn = opts; opts = null; }
        return runCmd(args, opts).then(function(r) {
            if (cmdOk(r)) return okFn(r);
            return failFn ? failFn(cmdErr(r)) : null;
        });
    }
    // Promise.all polyfill for cockpit promises
    function whenAll(promises) {
        return new Promise(function(resolve, reject) {
            var results = [], done = 0, failed = false;
            if (promises.length === 0) return resolve([]);
            promises.forEach(function(p, i) {
                p.then(function(v) { results[i] = v; done++; if (done === promises.length) resolve(results); },
                       function(e) { if (!failed) { failed = true; reject(e); } });
            });
        });
    }

    // ==================== Disk Operations ====================
    function getDiskList() {
        return runCmd(['lsblk', '-Jd', '-o', 'NAME,SIZE,MODEL,SERIAL,TRAN,ROTA,TYPE,VENDOR'])
            .then(function(data) {
                var parsed = JSON.parse(data); var disks = [];
                if (parsed && parsed.blockdevices) {
                    parsed.blockdevices.forEach(function(dev) {
                        if (dev.type === 'disk') {
                            disks.push({ name: '/dev/' + dev.name, size: dev.size || 'N/A',
                                model: (dev.model || '').trim(), serial: (dev.serial || '').trim(),
                                transport: (dev.tran || '').trim(), rota: dev.rota, vendor: (dev.vendor || '').trim() });
                        }
                    });
                }
                return disks;
            });
    }

    function getDiskDetail(device) {
        if (!device) return Promise.resolve({});
        var dev = device.replace('/dev/', '');
        return whenAll([
            runCmd(['smartctl', '-i', device]),
            runCmd(['smartctl', '-A', device]),
            isNvme(dev) ? runCmd(['nvme', 'smart-log', device]) : Promise.resolve(null),
            getTemperature(device)  // Use same source as dashboard
        ]).then(function(results) {
            var si = cmdOk(results[0]) ? results[0] : '';
            var sa = cmdOk(results[1]) ? results[1] : '';
            var nv = (results[2] && cmdOk(results[2])) ? results[2] : '';
            var temp = results[3]; // from getTemperature (same as dashboard)
            var info = parseSmartctlInfo(si);
            var attrs = parseSmartAttrTable(sa);
            // Prefer getTemperature (consistent with dashboard), fallback to attrs
            if (temp !== null) info.temperature = temp;
            else if (!info.temperature && attrs.temperature) info.temperature = attrs.temperature;
            if (!info.powerOnHours && attrs.powerOnHours) info.powerOnHours = attrs.powerOnHours;
            if (!info.powerCycles && attrs.powerCycles) info.powerCycles = attrs.powerCycles;
            if (nv) parseNvmeSmartLog(nv, info);
            return info;
        });
    }

    function isNvme(dev) { return dev.match(/^nvme/); }

    // 获取磁盘接口速度（缓存友好，不会唤醒休眠盘）
    function getInterfaceSpeed(device) {
        var dev = device.replace('/dev/', '');
        if (isNvme(dev)) {
            // NVMe: 读 PCIe 链路速度
            return runCmd(['cat', '/sys/block/' + dev + '/device/device']).then(function(pcieId) {
                if (!cmdOk(pcieId)) return 'NVMe';
                // 或者用 nvme id-ctrl 获取
                return runCmd(['nvme', 'id-ctrl', device, '-o', 'json']).then(function(ctrl) {
                    if (!cmdOk(ctrl)) return 'NVMe';
                    try {
                        var j = JSON.parse(ctrl);
                        var speed = j.vs && j.vs[0] ? 'NVMe' : 'NVMe';
                        // 从 sysfs 获取 PCIe link speed 更可靠
                        return runCmd(['cat', '/sys/block/' + dev + '/device/current_link_speed']).then(function(ls) {
                            return cmdOk(ls) ? 'NVMe ' + ls.trim() : 'NVMe';
                        });
                    } catch(e) { return 'NVMe'; }
                });
            });
        }
        // SATA/SAS: 从 smartctl -i 获取 SATA 版本
        return runCmd(['smartctl', '-i', device]).then(function(data) {
            if (!cmdOk(data)) return '-';
            if (data.indexOf('SATA Version is') !== -1) {
                var m = data.match(/SATA Version is:\s*(.+?)[\n\r]/);
                return m ? 'SATA ' + m[1].trim() : 'SATA';
            }
            if (data.indexOf('Transport:') !== -1) {
                var m2 = data.match(/Transport:\s*(.+?)[\n\r]/);
                return m2 ? m2[1].trim() : '-';
            }
            return '-';
        });
    }

    // Extract temperature from a SMART attribute line.
    // Attribute 194 (Temperature_Celsius) reports in °C natively — no conversion needed.
    // We take the first number from the raw-value field (index 9) to avoid
    // picking up trailing min/max data some drives append.
    function parseTempFromSmartLine(line) {
        var parts = line.trim().split(/\s+/);
        if (parts.length < 10) return null;
        var rawField = parts[9];
        var m = rawField.match(/(\d+)/);
        if (!m) return null;
        var val = parseInt(m[1]);
        // Sanity: valid disk temps are 0–120 °C; reject garbage
        if (val < 0 || val > 120) return null;
        return val;
    }

    function parseSmartAttrTable(output) {
        var result = { temperature: null, powerOnHours: null, powerCycles: null };
        if (!output) return result;
        output.split('\n').forEach(function(line) {
            if (line.indexOf('Power_On_Hours') !== -1) { var m = line.match(/\s+(\d+)\s*$/); if (m) result.powerOnHours = m[1]; }
            if (line.indexOf('Power_Cycle_Count') !== -1) { var m2 = line.match(/\s+(\d+)\s*$/); if (m2) result.powerCycles = m2[1]; }
            if (line.indexOf('Temperature_Celsius') !== -1 || line.indexOf('Airflow_Temperature') !== -1) {
                var temp = parseTempFromSmartLine(line);
                if (temp !== null) result.temperature = temp;
            }
        });
        return result;
    }

    function parseNvmeSmartLog(output, info) {
        output.split('\n').forEach(function(line) {
            if (line.indexOf('temperature') !== -1 && !info.temperature) {
                var m = line.match(/:\s*(\d+)/); if (m) info.temperature = parseInt(m[1]);
            }
            if (line.indexOf('power_on_hours') !== -1 && !info.powerOnHours) {
                var m2 = line.match(/:\s*(\d+)/); if (m2) info.powerOnHours = m2[1];
            }
            if (line.indexOf('power_cycles') !== -1 && !info.powerCycles) {
                var m3 = line.match(/:\s*(\d+)/); if (m3) info.powerCycles = m3[1];
            }
        });
    }

    // Parse nvme smart-log into SMART-like attribute rows for display
    function parseNvmeSmartAttrs(output) {
        var attrs = [];
        if (!output) return attrs;
        var fields = [
            { key: 'critical_warning', name: 'Critical Warning', thresh: '0' },
            { key: 'temperature', name: 'Temperature', thresh: '0' },
            { key: 'available_spare', name: 'Available Spare', thresh: '10' },
            { key: 'percentage_used', name: 'Percentage Used', thresh: '0' },
            { key: 'data_units_read', name: 'Data Units Read', thresh: '0' },
            { key: 'data_units_written', name: 'Data Units Written', thresh: '0' },
            { key: 'host_reads', name: 'Host Read Commands', thresh: '0' },
            { key: 'host_writes', name: 'Host Write Commands', thresh: '0' },
            { key: 'power_cycles', name: 'Power Cycles', thresh: '0' },
            { key: 'power_on_hours', name: 'Power On Hours', thresh: '0' },
            { key: 'unsafe_shutdowns', name: 'Unsafe Shutdowns', thresh: '0' },
            { key: 'media_errors', name: 'Media Errors', thresh: '0' },
            { key: 'num_err_log_entries', name: 'Error Log Entries', thresh: '0' }
        ];
        var lines = output.split('\n');
        fields.forEach(function(f, idx) {
            var raw = '';
            for (var i = 0; i < lines.length; i++) {
                var re = new RegExp(f.key + '\\s*:\\s*(.+)');
                var m = lines[i].match(re);
                if (m) { raw = m[1].trim(); break; }
            }
            if (!raw) return;
            var numVal = parseInt(raw);
            var st = 'good';
            var thresh = parseInt(f.thresh);
            if (f.key === 'critical_warning' && numVal > 0) st = 'bad';
            else if (f.key === 'media_errors' && numVal > 0) st = 'bad';
            else if (f.key === 'percentage_used' && numVal > 90) st = 'warn';
            else if (f.key === 'available_spare' && numVal < thresh) st = 'bad';
            attrs.push({ id: idx + 1, name: f.name, value: isNaN(numVal) ? raw : String(numVal), worst: '-', thresh: f.thresh, raw: raw, status: st });
        });
        return attrs;
    }

    function parseSmartctlInfo(output) {
        var info = {}; var lines = output.split('\n');
        var fields = { 'Model Family': 'modelFamily', 'Device Model': 'deviceModel', 'Serial Number': 'serial',
            'LU WWN Device Id': 'wwn', 'Firmware Version': 'firmware', 'User Capacity': 'capacity',
            'Sector Sizes': 'sectorSize', 'Rotation Rate': 'rotationRate', 'Form Factor': 'formFactor',
            'Transport': 'transport', 'SATA Version is': 'sataVersion', 'SMART support is': 'smartSupport' };
        lines.forEach(function(line) {
            for (var label in fields) {
                if (line.indexOf(label) !== -1) { var parts = line.split(':'); if (parts.length >= 2) info[fields[label]] = parts.slice(1).join(':').trim(); }
            }
            if (line.indexOf('Power_On_Hours') !== -1) { var m = line.match(/\s+(\d+)\s*$/); if (m) info.powerOnHours = m[1]; }
            if (line.indexOf('Power_Cycle_Count') !== -1) { var m2 = line.match(/\s+(\d+)\s*$/); if (m2) info.powerCycles = m2[1]; }
        });
        lines.forEach(function(line) {
            if (line.indexOf('Temperature_Celsius') !== -1 || line.indexOf('Airflow_Temperature') !== -1) {
                var temp = parseTempFromSmartLine(line);
                if (temp !== null) info.temperature = String(temp);
            }
        });
        return info;
    }

    function getPartitions(device) {
        if (!device) return Promise.resolve([]);
        return runCmd(['lsblk', '-J', '-o', 'NAME,SIZE,MOUNTPOINT,FSTYPE,TYPE', device])
            .then(function(data) {
                if (!cmdOk(data)) return [];
                var parsed = JSON.parse(data); var parts = [];
                function collect(devs) { if (!devs) return; devs.forEach(function(d) { if (d.type === 'part') parts.push({ name: '/dev/' + d.name, size: d.size || 'N/A', mountpoint: d.mountpoint || '-', fstype: d.fstype || '-' }); if (d.children) collect(d.children); }); }
                if (parsed && parsed.blockdevices) collect(parsed.blockdevices);
                return parts;
            }).catch(function() { return []; });
    }

    function getUsage() {
        return runCmd(['df', '-h', '--output=source,size,used,avail,pcent,target'])
            .then(function(data) {
                if (!cmdOk(data)) return {};
                var map = {}; data.trim().split('\n').forEach(function(line, i) {
                    if (i === 0) return; var p = line.trim().split(/\s+/);
                    if (p.length >= 6) map[p[0]] = { size: p[1], used: p[2], avail: p[3], percent: p[4], target: p[5] };
                }); return map;
            }).catch(function() { return {}; });
    }

    function getTemperature(device) {
        if (!device) return Promise.resolve(null);
        var dev = device.replace('/dev/', '');
        // NVMe: try nvme smart-log first
        if (isNvme(dev)) {
            return runCmd(['nvme', 'smart-log', device]).then(function(data) {
                if (!cmdOk(data)) return null;
                var m = data.match(/temperature\s*:\s*(\d+)/i);
                if (m) return parseInt(m[1]);
                return null;
            });
        }
        // ZFS: no temperature
        if (dev.match(/^zd/)) return Promise.resolve(null);
        // SATA: smartctl -A
        return runCmd(['smartctl', '-A', device]).then(function(data) {
            if (!cmdOk(data)) return null;
            var lines = data.split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf('Temperature_Celsius') !== -1 || lines[i].indexOf('Airflow_Temperature') !== -1) {
                    var temp = parseTempFromSmartLine(lines[i]);
                    if (temp !== null) return temp;
                }
            }
            return null;
        }).catch(function() { return null; });
    }

    function getSmartHealth(device) {
        if (!device) return Promise.resolve('unknown');
        var dev = device.replace('/dev/', '');
        if (isNvme(dev)) {
            return runCmd(['nvme', 'smart-log', device]).then(function(r) {
                if (!cmdOk(r)) return 'unknown';
                var m = r.match(/critical_warning\s*:\s*(\d+)/i);
                if (m && parseInt(m[1]) > 0) return 'failed';
                var m2 = r.match(/media_errors\s*:\s*(\d+)/i);
                if (m2 && parseInt(m2[1]) > 0) return 'failed';
                return 'passed';
            });
        }
        if (dev.match(/^zd/)) return Promise.resolve('none');
        // 先用 -H 检查，再用 -A 兜底
        return runCmd(['smartctl', '-H', device]).then(function(r) {
            if (cmdOk(r)) {
                var upper = r.toUpperCase();
                if (upper.indexOf('PASSED') !== -1 || upper.indexOf('OK') !== -1) return 'passed';
                if (upper.indexOf('FAILED') !== -1) return 'failed';
            }
            // -H 无法判断，检查属性表
            return runCmd(['smartctl', '-A', device]).then(function(attrs) {
                if (!cmdOk(attrs)) return 'unknown';
                var lines = attrs.split('\n'), inTable = false, hasFailed = false;
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (line.indexOf('ID#') !== -1 && line.indexOf('ATTRIBUTE_NAME') !== -1) { inTable = true; continue; }
                    if (!inTable) continue;
                    if (line.trim() === '') break;
                    var parts = line.trim().split(/\s+/);
                    if (parts.length >= 10) {
                        var v = parseInt(parts[3]), th = parseInt(parts[5]);
                        if (!isNaN(v) && !isNaN(th) && th > 0 && v < th) { hasFailed = true; break; }
                    }
                }
                return hasFailed ? 'failed' : 'passed';
            });
        });
    }

    function getSmartAttrs(device) {
        if (!device) return Promise.resolve([]);
        var dev = device.replace('/dev/', '');
        if (isNvme(dev)) {
            return runCmd(['nvme', 'smart-log', device]).then(function(r) {
                return cmdOk(r) ? parseNvmeSmartAttrs(r) : [];
            });
        }
        if (dev.match(/^zd/)) return Promise.resolve([]);
        return runCmd(['smartctl', '-A', device]).then(function(r) {
            if (!cmdOk(r)) return [];
            var attrs = []; var lines = r.split('\n'); var inTable = false;
            lines.forEach(function(line) {
                if (line.indexOf('ID#') !== -1 && line.indexOf('ATTRIBUTE_NAME') !== -1) { inTable = true; return; }
                if (!inTable) return; if (line.trim() === '') { inTable = false; return; }
                var parts = line.trim().split(/\s+/);
                if (parts.length >= 10) {
                    var id = parseInt(parts[0]); if (isNaN(id)) return;
                    var rawVal = parts.slice(9).join(' ');
                    var st = 'good'; var v = parseInt(parts[3]), th = parseInt(parts[5]);
                    // SMART VALUE: 归一化值，越高越好（初始100~200），THRESH 是最低可接受值
                    // VALUE < THRESH 时才算失败
                    if (!isNaN(v) && !isNaN(th) && th > 0 && v < th) st = 'bad';
                    attrs.push({ id: id, name: parts[1], value: parts[3], worst: parts[4], thresh: parts[5], raw: rawVal, status: st });
                }
            });
            return attrs;
        }).catch(function() { return []; });
    }

    function getErrorLog(device) {
        if (!device) return Promise.resolve({ count: 0, errors: [] });
        return runCmd(['smartctl', '-l', 'error', device]).then(function(data) {
            if (!cmdOk(data)) return { count: 0, errors: [] };
            var result = { count: 0, errors: [] };
            data.split('\n').forEach(function(line) {
                var m = line.match(/(\d+)\s+Errors?\s+in\s+SMART\s+error\s+log/i); if (m) result.count = parseInt(m[1]);
                var m2 = line.match(/SMART\s+Error\s+Logging.*:\s+(\d+)/i); if (m2) result.count = parseInt(m2[1]);
            });
            if (result.count === 0 && data.indexOf('No Errors Logged') !== -1) result.count = 0;
            return result;
        }).catch(function() { return { count: 0, errors: [] }; });
    }

    function getHibState(device) {
        if (!device) return Promise.resolve({ state: 'unknown', detail: '' });
        var dev = device.replace('/dev/', '');

        // NVMe: read power state from sysfs
        if (isNvme(dev)) {
            var nvmeDev = dev.replace(/\d+$/, ''); // nvme0n1 -> nvme0
            var sysPath = '/sys/block/' + dev + '/device/power_state';
            return cockpit.file(sysPath).read()
                .then(function(data) {
                    var state = (data || '').trim();
                    var s = 'unknown';
                    if (state.indexOf('0') === 0 || state === 'active') s = 'active';
                    else if (state.indexOf('1') === 0 || state.indexOf('2') === 0) s = 'standby';
                    else if (state.indexOf('3') === 0 || state.indexOf('4') === 0 || state.indexOf('5') === 0) s = 'sleep';
                    else s = 'active';
                    return { state: s, detail: 'NVMe power_state: ' + state };
                })
                .fail(function() {
                    return runCmd(['nvme', 'id-ctrl', device])
                        .then(function(r) {
                            return { state: 'active', detail: 'NVMe controller active' };
                        });
                });
        }

        // ZFS zvol: virtual device, no hardware power state
        if (dev.match(/^zd/)) {
            return Promise.resolve({ state: 'virtual', detail: 'ZFS zvol - no hardware power state' });
        }

        // SATA/IDE/SCSI: use hdparm
        return runCmd(['hdparm', '-C', device]).then(function(data) {
            if (!cmdOk(data)) return { state: 'unknown', detail: 'hdparm failed' };
            var s = 'unknown';
            if (data.indexOf('active/idle') !== -1) s = 'active';
            else if (data.indexOf('standby') !== -1) s = 'standby';
            else if (data.indexOf('sleeping') !== -1) s = 'sleep';
            return { state: s, detail: data.trim() };
        }).catch(function() {
            return runCmd(['smartctl', '-i', device]).then(function(data) {
                if (!cmdOk(data)) return { state: 'unknown', detail: 'Cannot determine power state' };
                var s = 'unknown';
                if (data.indexOf('ACTIVE') !== -1 || data.indexOf('active') !== -1) s = 'active';
                else if (data.indexOf('STANDBY') !== -1 || data.indexOf('standby') !== -1) s = 'standby';
                else if (data.indexOf('SLEEP') !== -1 || data.indexOf('sleep') !== -1) s = 'sleep';
                return { state: s, detail: 'via smartctl' };
            });
        });
    }

    function getApm(device) {
        if (!device) return Promise.resolve({ level: 0, enabled: false, supported: false });
        var dev = device.replace('/dev/', '');
        // NVMe: no hdparm APM
        if (isNvme(dev)) {
            return Promise.resolve({ level: 0, enabled: false, supported: false });
        }
        // ZFS: no APM
        if (dev.match(/^zd/)) {
            return Promise.resolve({ level: 0, enabled: false, supported: false });
        }
        return runCmd(['hdparm', '-B', device]).then(function(data) {
            if (!cmdOk(data)) return { level: 0, enabled: false, supported: false };
            var str = (typeof data === 'string') ? data : '';
            
            // 检查是否不支持 APM: "APM_level = not supported"
            if (str.indexOf('not supported') !== -1) {
                return { level: 0, enabled: false, supported: false };
            }
            
            // 检查是否禁用: "APM_level = off"
            if (str.indexOf('= off') !== -1 || str.indexOf('=off') !== -1) {
                return { level: 255, enabled: false, supported: true };
            }
            
            // 检查数字值: "APM_level = 128" 或 "= 128"
            var m = str.match(/=\s*(\d+)/);
            if (m) {
                var l = parseInt(m[1]);
                if (l === 0) return { level: 0, enabled: false, supported: false };
                // 255 = disabled, 但仍然 supported
                return { level: l, enabled: l > 0 && l < 255, supported: true };
            }
            
            // 没有匹配到任何已知模式
            return { level: 0, enabled: false, supported: false };
        }).catch(function() { return { level: 0, enabled: false, supported: false }; });
    }

    function getWriteCache(device) {
        if (!device) return Promise.resolve({ enabled: false, supported: false });
        var dev = device.replace('/dev/', '');
        if (isNvme(dev) || dev.match(/^zd/)) {
            return Promise.resolve({ enabled: false, supported: false });
        }
        return runCmd(['hdparm', '-W', device]).then(function(data) {
            if (!cmdOk(data)) return { enabled: false, supported: false };
            var str = typeof data === 'string' ? data : '';
            if (str.indexOf('not supported') !== -1) return { enabled: false, supported: false };
            // "write-caching =   1" or "write-caching =   0"
            var m = str.match(/write-caching\s*=\s*(\d+)/i);
            if (m) return { enabled: parseInt(m[1]) === 1, supported: true };
            // fallback: check for "on"/"off"
            if (str.indexOf('write-caching') !== -1) {
                return { enabled: str.indexOf('= 1') !== -1 || str.indexOf('on') !== -1, supported: true };
            }
            return { enabled: false, supported: false };
        }).catch(function() { return { enabled: false, supported: false }; });
    }

    function getSelfTestStatus(device) {
        if (!device) return Promise.resolve({ running: false, type: '', remaining: '' });
        return runCmd(['smartctl', '-c', device]).then(function(data) {
            if (!cmdOk(data)) return { running: false, type: '', remaining: '' };
            var result = { running: false, type: '', remaining: '' };
            var m = data.match(/Self-test execution status:\s+\(\s*(\d+)\s*\)/);
            if (m) { var s = parseInt(m[1]); if (s > 0 && s < 127) { result.running = true;
                var rm = data.match(/(\d+)%\s+of test remaining/i); if (rm) result.remaining = rm[1] + '%';
                if (s <= 2) result.type = 'short'; else if (s <= 4) result.type = 'extended'; else if (s <= 6) result.type = 'conveyance'; } }
            return result;
        }).catch(function() { return { running: false, type: '', remaining: '' }; });
    }

    function getSelfTestLog(device) {
        if (!device) return Promise.resolve({ entries: [] });
        return runCmd(['smartctl', '-l', 'selftest', device]).then(function(data) {
            if (!cmdOk(data)) return { entries: [] };
            var entries = []; var lines = data.split('\n');
            lines.forEach(function(line) {
                var m = line.match(/^\s*(\d+)\s+(.+?)\s+(Completed without error|Completed:.*|Self-test.*|Aborted.*)\s+(\d+%\s+)?(\d+)?\s*(.*)?$/);
                if (m) entries.push({ num: m[1], description: m[2].trim(), status: m[3].trim(), lifetime: (m[5] || '').trim() });
            });
            return { entries: entries };
        }).catch(function() { return { entries: [] }; });
    }

    // ==================== Init ====================
    function init() {
        $html = document.documentElement; $body = document.body;
        $sidebar = document.getElementById('sidebar'); $sidebarOverlay = document.getElementById('sidebarOverlay');
        $sidebarNav = document.getElementById('sidebarNav'); $topMenuBar = document.getElementById('topMenuBar');
        $hamburgerBtn = document.getElementById('hamburgerBtn'); $settingsOverlay = document.getElementById('settingsOverlay');
        $toastContainer = document.getElementById('toastContainer');
        $themeIconSun = document.getElementById('themeIconSun'); $themeIconMoon = document.getElementById('themeIconMoon');

        // Ensure config dir exists, then load settings & data
        ensureConfigDir().then(function() {
            return whenAll([loadState(), loadData()]);
        }).then(function() {
            currentLang = state.lang || 'zh-CN'; currentTheme = state.theme || 'light';
            accentColor = state.accentColor || '#4f6ef7'; sidebarOpen = state.sidebarOpen !== false;

            $html.lang = currentLang;

            // Load language JSON first, then boot everything
            return loadLang(currentLang);
        }).then(function() {
            updateAllI18n();
            applyTheme(currentTheme); applyAccentColor(accentColor);
            applyEffectiveLayout(getEffectiveLayout()); syncSidebarBodyClass(); updateLayoutIcons();
            buildMenus(); setActiveMenu('dashboard');
            initCustomSelects(); bindEvents();
            loadDiskList();
            setTimeout(refreshDashboard, 500);
            startAutoRefresh();
        });
    }

    // ==================== Theme ====================
    function applyTheme(theme) {
        currentTheme = theme; state.theme = theme; saveState();
        if (theme === 'system') { var pd = window.matchMedia('(prefers-color-scheme: dark)').matches; $html.setAttribute('data-theme', pd ? 'dark' : 'light'); }
        else $html.setAttribute('data-theme', theme);
        updateThemeIcons(); applyAccentColor(accentColor);
    }
    function updateThemeIcons() { var d = $html.getAttribute('data-theme') === 'dark'; $themeIconSun.style.display = d ? 'none' : ''; $themeIconMoon.style.display = d ? '' : 'none'; }
    function toggleTheme() { var n = $html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; applyTheme(n); showToast(t('toastThemeChanged'), 'success', 2.5); }

    function applyAccentColor(color) {
        accentColor = color; state.accentColor = color; saveState();
        var r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
        var hr = Math.max(0, r - 20), hg = Math.max(0, g - 20), hb = Math.max(0, b - 20);
        $html.style.setProperty('--accent', color);
        $html.style.setProperty('--accent-hover', '#' + hr.toString(16).padStart(2, '0') + hg.toString(16).padStart(2, '0') + hb.toString(16).padStart(2, '0'));
        $html.style.setProperty('--accent-light', 'rgba(' + r + ',' + g + ',' + b + ',0.1)');
        $html.style.setProperty('--accent-glow', 'rgba(' + r + ',' + g + ',' + b + ',0.25)');
        if ($html.getAttribute('data-theme') === 'dark') {
            var lr = Math.min(255, r + 30), lg = Math.min(255, g + 30), lb = Math.min(255, b + 30);
            $html.style.setProperty('--accent-hover', '#' + lr.toString(16).padStart(2, '0') + lg.toString(16).padStart(2, '0') + lb.toString(16).padStart(2, '0'));
            $html.style.setProperty('--accent-light', 'rgba(' + r + ',' + g + ',' + b + ',0.15)');
        }
        document.querySelectorAll('.logo-icon').forEach(function(el) { el.style.background = 'linear-gradient(135deg, ' + color + ', #8b5cf6)'; });
        document.querySelectorAll('.color-swatch').forEach(function(el) { el.classList.toggle('active', el.dataset.color === color); });
        var cp = document.getElementById('colorCustomPicker'), hi = document.getElementById('colorHexInput');
        if (cp) cp.value = color; if (hi) hi.value = color.toUpperCase();
    }

    // ==================== Layout ====================
    function getEffectiveLayout() { return state.menuLayout === 'auto' ? 'top' : state.menuLayout; }
    function applyEffectiveLayout(eff) {
        if (eff === 'top') {
            $body.classList.add('menu-top'); $body.classList.remove('menu-side', 'sidebar-collapsed');
            $sidebar.classList.add('collapsed'); $sidebar.classList.remove('mobile-open');
            $sidebarOverlay.classList.remove('show'); mobileSidebarOpen = false; $hamburgerBtn.style.display = 'none';
        } else {
            $body.classList.remove('menu-top'); $body.classList.add('menu-side');
            $sidebar.classList.remove('collapsed'); sidebarOpen = true; $hamburgerBtn.style.display = 'flex';
            if (window.innerWidth <= 768) { $sidebar.classList.remove('mobile-open'); $sidebar.classList.add('collapsed'); sidebarOpen = false; }
            syncSidebarBodyClass();
        }
    }
    function syncSidebarBodyClass() { $body.classList.toggle('sidebar-collapsed', $sidebar.classList.contains('collapsed')); }
    function updateLayoutIcons() {
        var ti = document.getElementById('layoutIconTop'), si = document.getElementById('layoutIconSide');
        if (getEffectiveLayout() === 'top') { ti.style.display = ''; si.style.display = 'none'; }
        else { ti.style.display = 'none'; si.style.display = ''; }
    }
    function toggleSidebar() {
        if (window.innerWidth <= 768) { if (mobileSidebarOpen) closeMobileSidebar(); else openMobileSidebar(); }
        else { sidebarOpen = !sidebarOpen; if (sidebarOpen) $sidebar.classList.remove('collapsed'); else $sidebar.classList.add('collapsed'); syncSidebarBodyClass(); state.sidebarOpen = sidebarOpen; saveState(); }
    }
    function openMobileSidebar() { mobileSidebarOpen = true; $sidebar.classList.add('mobile-open'); $sidebar.classList.remove('collapsed'); $sidebarOverlay.classList.add('show'); $body.style.overflow = 'hidden'; }
    function closeMobileSidebar() { mobileSidebarOpen = false; $sidebar.classList.remove('mobile-open'); $sidebar.classList.add('collapsed'); $sidebarOverlay.classList.remove('show'); $body.style.overflow = ''; }

    // ==================== Menu ====================
    function buildMenus() {
        var sHTML = '', curSec = null;
        menuItems.forEach(function(item) {
            if (item.section !== curSec && sectionLabels[item.section]) { sHTML += '<div class="menu-label">' + t(sectionLabels[item.section]) + '</div>'; curSec = item.section; }
            sHTML += '<div class="menu-item" data-menu-id="' + item.id + '" role="menuitem" tabindex="0"><span class="menu-icon">' + (menuIcons[item.icon] || '') + '</span><span>' + t(item.labelKey) + '</span></div>';
        });
        $sidebarNav.innerHTML = sHTML;
        var tHTML = '';
        menuItems.forEach(function(item) { tHTML += '<div class="menu-item" data-menu-id="' + item.id + '" role="menuitem" tabindex="0"><span class="menu-icon">' + (menuIcons[item.icon] || '') + '</span><span>' + t(item.labelKey) + '</span></div>'; });
        $topMenuBar.innerHTML = tHTML;
        bindMenuClicks();
    }
    function bindMenuClicks() {
        document.querySelectorAll('.menu-item[data-menu-id]').forEach(function(el) {
            el.addEventListener('click', function() { setActiveMenu(el.getAttribute('data-menu-id')); if (window.innerWidth <= 768 && getEffectiveLayout() === 'side') closeMobileSidebar(); });
        });
    }
    function setActiveMenu(id) {
        document.querySelectorAll('.menu-item[data-menu-id]').forEach(function(el) { el.classList.toggle('active', el.getAttribute('data-menu-id') === id); });
        document.querySelectorAll('.demo-section').forEach(function(el) { el.classList.remove('active'); });
        var target = document.getElementById('sec-' + id); if (target) target.classList.add('active');
        onSectionActive(id);
    }

    function onSectionActive(id) {
        if (id !== 'iomonitor') { IoMonitor_stop(); }
        if (id !== 'hibernation') { 
            if (hibTimer) { clearInterval(hibTimer); hibTimer = null; }
            if (hibHistoryLiveTimer) { clearInterval(hibHistoryLiveTimer); hibHistoryLiveTimer = null; }
        }
        if (id !== 'selftest') {
            if (selfTestTimer) { clearInterval(selfTestTimer); selfTestTimer = null; }
        }
        switch (id) {
            case 'dashboard': refreshDashboard(); break;
            case 'diskinfo': refreshDiskInfo(); break;
            case 'smart': refreshSmart(); break;
            case 'hibernation': refreshHib(); break;
            case 'iomonitor': startIoMonitor(); break;
            case 'selftest': refreshSelfTest(); break;
        }
    }

    function refreshCurrentSection() {
        var active = document.querySelector('.menu-item[data-menu-id].active');
        if (active) onSectionActive(active.getAttribute('data-menu-id'));
    }

    function startAutoRefresh() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        var interval = (state.refreshInterval || 5) * 1000;
        if (interval < 1000) interval = 5000;
        refreshTimer = setInterval(function() {
            // IO 监控有自己的刷新机制，跳过
            // 硬盘信息和 SMART 健康页面不自动刷新（避免唤醒休眠硬盘）
            var active = document.querySelector('.menu-item[data-menu-id].active');
            if (active) {
                var menuId = active.getAttribute('data-menu-id');
                if (menuId === 'iomonitor' || menuId === 'diskinfo' || menuId === 'smart') {
                    return;
                }
                refreshCurrentSection();
            }
        }, interval);
    }

    // ==================== IO Monitor (inline) ====================
    var ioPrevStats = {}, ioHistory = {}, ioMaxHistory = 60, ioListeners = [], ioTimer = null, ioInterval = 1000;
    var ioExpandedDisks = {}; // 记录展开状态
    var ioDiskModels = {}; // 磁盘型号缓存 { 'sda': 'Samsung SSD 870', ... }

    function IoMonitor_start() {
        if (ioTimer) return;
        cockpit.file('/proc/diskstats').read().then(function(data) { ioPrevStats = parseDiskStats(data); });
        ioTimer = setInterval(IoMonitor_poll, ioInterval);
        IoMonitor_poll();
    }
    function IoMonitor_stop() { if (ioTimer) { clearInterval(ioTimer); ioTimer = null; } }
    function IoMonitor_restart() { IoMonitor_stop(); IoMonitor_start(); }
    function IoMonitor_poll() {
        cockpit.file('/proc/diskstats').read().then(function(data) {
            var curr = parseDiskStats(data);
            if (Object.keys(ioPrevStats).length > 0) {
                var delta = {};
                for (var dev in curr) {
                    if (!ioPrevStats[dev]) continue;
                    var p = ioPrevStats[dev], c = curr[dev], dt = ioInterval / 1000;
                    delta[dev] = {
                        readBps: Math.max(0, (c.sectorsRead - p.sectorsRead) * 512 / dt),
                        writeBps: Math.max(0, (c.sectorsWritten - p.sectorsWritten) * 512 / dt),
                        readIops: Math.max(0, (c.readsCompleted - p.readsCompleted) / dt),
                        writeIops: Math.max(0, (c.writesCompleted - p.writesCompleted) / dt),
                        ioUtil: Math.min(100, Math.max(0, (c.ioTimeMs - p.ioTimeMs) / dt / 10 * 100)),
                        timestamp: Date.now()
                    };
                }
                for (var d in delta) { if (!ioHistory[d]) ioHistory[d] = []; ioHistory[d].push(delta[d]); if (ioHistory[d].length > ioMaxHistory) ioHistory[d].shift(); }
                ioListeners.forEach(function(fn) { fn({ delta: delta, history: ioHistory }); });
            }
            ioPrevStats = curr;
        });
    }
    function parseDiskStats(data) {
        var stats = {};
        data.trim().split('\n').forEach(function(line) {
            var p = line.trim().split(/\s+/);
            if (p.length >= 14) {
                var name = p[2];
                // 匹配磁盘和分区：sda, sda1, nvme0n1, nvme0n1p1
                if (name.match(/^(sd|vd|nvme|hd|xvd)[a-z0-9]+(p\d+)?$/i)) {
                    stats[name] = { readsCompleted: parseInt(p[3])||0, sectorsRead: parseInt(p[5])||0, readTimeMs: parseInt(p[6])||0,
                        writesCompleted: parseInt(p[7])||0, sectorsWritten: parseInt(p[9])||0, writeTimeMs: parseInt(p[10])||0, ioTimeMs: parseInt(p[12])||0 };
                }
            }
        });
        return stats;
    }
    function formatSpeed(bps) {
        if (bps < 1024) return bps.toFixed(0) + ' B/s'; if (bps < 1048576) return (bps/1024).toFixed(1) + ' KB/s';
        if (bps < 1073741824) return (bps/1048576).toFixed(1) + ' MB/s'; return (bps/1073741824).toFixed(2) + ' GB/s';
    }

    // ==================== Disk Loading ====================
    function loadDiskList() {
        getDiskList().then(function(disks) {
            populateDiskSelectors(disks);
            if (disks.length > 0) {
                var sv = state.selectedDisk; var found = disks.find(function(d) { return d.name === sv; });
                selectedDisk = found ? sv : disks[0].name; setDiskSelectValue(selectedDisk);
            }
        });
    }
    function populateDiskSelectors(disks) {
        function categorize(list) {
            var groups = { sata: [], nvme: [], zfs: [], other: [] };
            list.forEach(function(d) {
                var dev = d.name.replace('/dev/', '');
                if (dev.match(/^nvme/)) groups.nvme.push(d);
                else if (dev.match(/^sd|^hd|^vd|^xvd/)) groups.sata.push(d);
                else if (dev.match(/^zd/)) groups.zfs.push(d);
                else groups.other.push(d);
            });
            return groups;
        }
        // hibDiskSelect: only SATA/SAS (hdparm only works on these)
        var sataOnlySels = ['hibDiskSelect'];
        // smart/selftest: exclude ZFS virtual disks
        var noZfsSels = ['smartDiskSelect', 'selfTestDiskSelect'];
        // all others: all disks
        var allSels = ['dashboardDiskSelect', 'diskInfoSelect'];

        function fillSelect(sel, diskList) {
            sel.innerHTML = '';
            if (diskList.length === 0) { var o = document.createElement('option'); o.value = ''; o.textContent = t('diskNoDisk'); sel.appendChild(o); return; }
            var groups = categorize(diskList);
            [{k:'sata',l:'SATA / SAS'},{k:'nvme',l:'NVMe'},{k:'zfs',l:'ZFS / ZVOL'},{k:'other',l:'Other'}].forEach(function(g) {
                if (groups[g.k].length === 0) return;
                var optgroup = document.createElement('optgroup'); optgroup.label = g.l;
                groups[g.k].forEach(function(d) { var o = document.createElement('option'); o.value = d.name; o.textContent = d.name + ' - ' + (d.model || d.size); optgroup.appendChild(o); });
                sel.appendChild(optgroup);
            });
        }

        var groups = categorize(disks);
        allSels.forEach(function(id) {
            var sel = document.getElementById(id); if (!sel) return;
            fillSelect(sel, disks);
            sel.addEventListener('change', function() {
                selectedDisk = sel.value; state.selectedDisk = selectedDisk; saveState(); setDiskSelectValue(selectedDisk);
                apmEditing = false; cacheEditing = false;
                refreshCurrentSection();
            });
        });
        noZfsSels.forEach(function(id) {
            var sel = document.getElementById(id); if (!sel) return;
            var noZfs = disks.filter(function(d) { return !d.name.match(/\/dev\/zd/); });
            fillSelect(sel, noZfs);
            sel.addEventListener('change', function() {
                selectedDisk = sel.value; state.selectedDisk = selectedDisk; saveState(); setDiskSelectValue(selectedDisk);
                apmEditing = false; cacheEditing = false;
                refreshCurrentSection();
            });
        });
        sataOnlySels.forEach(function(id) {
            var sel = document.getElementById(id); if (!sel) return;
            fillSelect(sel, groups.sata);
            sel.addEventListener('change', function() {
                selectedDisk = sel.value; state.selectedDisk = selectedDisk; saveState(); setDiskSelectValue(selectedDisk);
                apmEditing = false; cacheEditing = false;
                refreshCurrentSection();
            });
        });
    }
    function setDiskSelectValue(v) { ['dashboardDiskSelect', 'diskInfoSelect', 'smartDiskSelect', 'hibDiskSelect', 'selfTestDiskSelect'].forEach(function(id) { var s = document.getElementById(id); if (s) s.value = v; }); }

    // ==================== Dashboard ====================
    function refreshDashboard() {
        refreshBackendCache().then(function() {
            return getDiskList();
        }).then(function(disks) {
            var el;
            el = document.getElementById('dashTotalDisks'); if (el) el.textContent = disks.length;

            // 过滤掉虚拟磁盘
            var realDisks = disks.filter(function(d) { return !d.name.match(/\/dev\/zd/); });

            // Stats: health (per disk, don't let one failure break all)
            var healthDone = 0, healthy = 0, warning = 0, critical = 0;
            if (realDisks.length === 0) {
                el = document.getElementById('dashHealthy'); if (el) el.textContent = 0;
                el = document.getElementById('dashWarning'); if (el) el.textContent = 0;
                el = document.getElementById('dashCritical'); if (el) el.textContent = 0;
            }
            realDisks.forEach(function(d) {
                cachedQuery(d.name, 'health', function() { return getSmartHealth(d.name); }).then(function(h) {
                    if (h === 'passed') healthy++; else if (h === 'failed') critical++; else warning++;
                }).finally(function() {
                    healthDone++;
                    if (healthDone >= realDisks.length) {
                        el = document.getElementById('dashHealthy'); if (el) el.textContent = healthy;
                        el = document.getElementById('dashWarning'); if (el) el.textContent = warning;
                        el = document.getElementById('dashCritical'); if (el) el.textContent = critical;
                    }
                });
            });

            // Total capacity
            var totalSize = disks.reduce(function(sum, d) { var m = d.size.match(/([\d.]+)\s*(G|T|M|K)/i); if (!m) return sum; var v = parseFloat(m[1]), u = m[2].toUpperCase(); return sum + (u==='T'?v*1024:u==='G'?v:u==='M'?v/1024:0); }, 0);
            el = document.getElementById('dashTotalCapacity'); if (el) el.textContent = totalSize >= 1024 ? (totalSize/1024).toFixed(1) + ' TB' : totalSize.toFixed(0) + ' GB';

            // Average temperature
            var tempDone = 0, temps = [];
            disks.forEach(function(d) {
                cachedQuery(d.name, 'temp', function() { return getTemperature(d.name); }).then(function(t) { if (t !== null && t > 0) temps.push(t); }).finally(function() {
                    tempDone++;
                    if (tempDone >= disks.length) {
                        el = document.getElementById('dashAvgTemp');
                        if (el) el.textContent = temps.length > 0 ? Math.round(temps.reduce(function(a,b){return a+b;},0)/temps.length) + '°C' : t('diskNotAvailable');
                    }
                });
            });

            renderDashTable(disks);
        });
    }
    function refreshDashRow(d) {
        var pwrEl = document.querySelector('[data-disk-pwr="' + d.name + '"]');
        var runtimeEl = document.querySelector('[data-disk-runtime="' + d.name + '"]');
        var healthEl = document.querySelector('[data-disk-health="' + d.name + '"]');
        var tempEl = document.querySelector('[data-disk-temp="' + d.name + '"]');

        // 电源状态（hdparm -C 不唤醒磁盘）
        if (pwrEl) {
            getHibState(d.name).then(function(hibResult) {
                var st = hibResult.state;
                if ((st==='standby'||st==='sleep') && !backendDataCache.standbySince[d.name]) {
                    backendDataCache.standbySince[d.name] = Date.now();
                    delete backendDataCache.activeSince[d.name];
                } else if (st==='active' && backendDataCache.standbySince[d.name]) {
                    delete backendDataCache.standbySince[d.name];
                    if (!backendDataCache.activeSince[d.name]) backendDataCache.activeSince[d.name] = Date.now();
                }
                
                // 状态颜色
                var color = st==='active'?'var(--success)':st==='standby'||st==='sleep'?'var(--warning)':'var(--text-tertiary)';
                pwrEl.style.color = color;
                pwrEl.style.fontWeight = '600';
                
                // 状态文本
                var stateText = st==='active'?t('hibernateActive'):st==='standby'?t('hibernateStandby'):st==='sleep'?t('hibernateSleeping'):'-';
                pwrEl.textContent = stateText;
                
                // 运行时间（单独一列，颜色和状态相同）
                if (runtimeEl) {
                    var durationText = '';
                    if (st==='active' && backendDataCache.activeSince[d.name]) {
                        durationText = formatDuration(Date.now()-backendDataCache.activeSince[d.name]);
                    } else if ((st==='standby'||st==='sleep') && backendDataCache.standbySince[d.name]) {
                        durationText = formatDuration(Date.now()-backendDataCache.standbySince[d.name]);
                    }
                    runtimeEl.textContent = durationText || '-';
                    runtimeEl.style.color = color;
                }

                // 仅活动盘查 SMART 和温度
                if (st === 'active') {
                    cachedQuery(d.name, 'health', function() { return getSmartHealth(d.name); }).then(function(h) {
                        updateHealthCell(healthEl, h);
                    });
                    cachedQuery(d.name, 'temp', function() { return getTemperature(d.name); }).then(function(temp) {
                        updateTempCell(tempEl, temp);
                    });
                } else {
                    var cached = getCachedDisk(d.name);
                    updateHealthCell(healthEl, cached && cached.health);
                    updateTempCell(tempEl, cached && cached.temp);
                }
            });
        }
    }
    
    // 辅助函数：更新健康状态单元格（增量更新）
    function updateHealthCell(el, health) {
        if (!el) return;
        var text = health==='passed'?t('smartPassed'):health==='failed'?t('smartFailed'):health?health:'-';
        var color = health==='passed'?'var(--success)':health==='failed'?'var(--danger)':'var(--warning)';
        el.textContent = text;
        el.style.color = color;
    }
    
    // 辅助函数：更新温度单元格（增量更新）
    function updateTempCell(el, temp) {
        if (!el) return;
        el.textContent = (temp !== null && temp !== undefined) ? temp + '°C' : '-';
    }

    function renderDashTable(disks) {
        var tbody = document.getElementById('dashDiskTableBody'); if (!tbody) return;
        if (disks.length === 0) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><div class="empty-text">' + t('diskNoDisk') + '</div></td></tr>'; return; }

        // 检查磁盘列表是否变化（避免每次刷新重建表格导致闪烁）
        var diskKey = disks.map(function(d) { return d.name; }).sort().join(',');
        var existingKey = tbody.getAttribute('data-disk-key') || '';

        if (diskKey === existingKey) {
            // 磁盘列表未变，只更新异步数据
            disks.forEach(function(d) {
                var dev = d.name.replace('/dev/', '');
                var isVirtual = dev.match(/^zd/);
                if (!isVirtual) refreshDashRow(d);
            });
            return;
        }

        // 首次加载或磁盘列表变化，重建表格
        tbody.setAttribute('data-disk-key', diskKey);
        var thead = document.querySelector('#sec-dashboard .simple-table thead tr');
        if (thead) thead.innerHTML = '<th style="width:10%">Device</th><th style="width:18%" data-i18n="diskModel">型号</th><th style="width:8%" data-i18n="diskCapacity">容量</th><th style="width:10%" data-i18n="diskTransport">接口</th><th style="width:8%" data-i18n="diskTemperature">温度</th><th style="width:10%" data-i18n="hibernateCurrentState">状态</th><th style="width:14%" data-i18n="dashboardRuntime">运行时间</th><th style="width:10%" data-i18n="smartHealthStatus">健康</th>';
        tbody.innerHTML = '';

        // Categorize disks
        var categories = {
            sata: { label: 'SATA / SAS', disks: [] },
            nvme: { label: 'NVMe', disks: [] },
            zfs:  { label: 'ZFS / ZVOL', disks: [] },
            other: { label: 'Other', disks: [] }
        };
        disks.forEach(function(d) {
            var dev = d.name.replace('/dev/', '');
            if (dev.match(/^nvme/)) categories.nvme.disks.push(d);
            else if (dev.match(/^sd|^hd|^vd|^xvd/)) categories.sata.disks.push(d);
            else if (dev.match(/^zd/)) categories.zfs.disks.push(d);
            else categories.other.disks.push(d);
        });

        var order = ['sata', 'nvme', 'zfs', 'other'];
        order.forEach(function(key) {
            var cat = categories[key];
            if (cat.disks.length === 0) return;

            // Category header row
            var hdr = document.createElement('tr');
            hdr.innerHTML = '<td colspan="8" style="padding:10px 14px 4px;font-weight:700;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-tertiary);background:var(--bg-tertiary);">' +
                escapeHtml(cat.label) + ' <span style="font-weight:400;opacity:0.7;">(' + cat.disks.length + ')</span></td>';
            tbody.appendChild(hdr);

            cat.disks.forEach(function(d) {
                var dev = d.name.replace('/dev/', '');
                var isVirtual = dev.match(/^zd/);

                var tr = document.createElement('tr');
                tr.innerHTML = '<td><strong>' + escapeHtml(d.name) + '</strong></td>' +
                    '<td>' + escapeHtml(d.model || '-') + '</td>' +
                    '<td>' + escapeHtml(d.size) + '</td>' +
                    '<td>' + escapeHtml(d.transport || '-') + '</td>' +
                    '<td data-disk-temp="' + escapeHtml(d.name) + '" style="font-family:var(--font-mono)">-</td>' +
                    '<td data-disk-pwr="' + escapeHtml(d.name) + '" style="font-weight:600">-</td>' +
                    '<td data-disk-runtime="' + escapeHtml(d.name) + '">-</td>' +
                    '<td data-disk-health="' + escapeHtml(d.name) + '" style="font-weight:600">' + (isVirtual ? '-' : '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>') + '</td>';
                tbody.appendChild(tr);

                // 异步加载数据
                if (!isVirtual) refreshDashRow(d);
            });
        });
    }

    // ==================== Disk Info ====================
    function refreshDiskInfo() {
        if (!selectedDisk) return;
        var ld = document.getElementById('diskInfoLoading'), ct = document.getElementById('diskInfoContent');
        if (ld) ld.style.display = 'flex'; if (ct) ct.style.display = 'none';
        // 刷新按钮强制获取最新数据
        whenAll([getDiskDetail(selectedDisk), getPartitions(selectedDisk), getUsage()]).then(function(r) {
            setCachedDisk(selectedDisk, { info: r[0] });
            renderDiskDetail(r[0]||{}); renderPartitions(r[1]||[], r[2]||{});
            if (ld) ld.style.display = 'none'; if (ct) ct.style.display = 'block';
        });
    }
    function renderDiskDetail(info) {
        var grid = document.getElementById('diskDetailGrid'); if (!grid) return;
        var fields = [
            { lk: 'diskModel', v: info.deviceModel || info.modelFamily || '-' },
            { lk: 'diskSerial', v: info.serial || '-' }, { lk: 'diskFirmware', v: info.firmware || '-' },
            { lk: 'diskCapacity', v: info.capacity || '-' }, { lk: 'diskInterface', v: info.transport || info.sataVersion || '-' },
            { lk: 'diskRotation', v: info.rotationRate || '-' }, { lk: 'diskFormFactor', v: info.formFactor || '-' },
            { lk: 'diskSectorSize', v: info.sectorSize || '-' }, { lk: 'diskPowerOnHours', v: info.powerOnHours ? formatHours(info.powerOnHours) : '-' },
            { lk: 'diskPowerCycles', v: info.powerCycles || '-' }, { lk: 'diskTemperature', v: info.temperature ? info.temperature + '°C' : '-' }
        ];
        grid.innerHTML = '';
        fields.forEach(function(f) { grid.innerHTML += '<div class="info-row"><span class="info-label">' + t(f.lk) + '</span><span class="info-value">' + escapeHtml(f.v) + '</span></div>'; });
    }
    function renderPartitions(parts, usage) {
        var tbody = document.getElementById('partitionTableBody'); if (!tbody) return;
        if (parts.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state">-</td></tr>'; return; }
        tbody.innerHTML = '';
        parts.forEach(function(p) {
            var u = usage[p.name]; var us = '-';
            if (u) us = '<div class="progress-bar-wrap" style="margin:0;min-width:100px;"><div class="progress-label"><span>'+escapeHtml(u.used)+'/'+escapeHtml(u.size)+'</span><span>'+escapeHtml(u.percent)+'</span></div><div class="progress-bar"><div class="progress-fill fill-accent" style="width:'+escapeHtml(u.percent)+'"></div></div></div>';
            tbody.innerHTML += '<tr><td>'+escapeHtml(p.name)+'</td><td>'+escapeHtml(p.size)+'</td><td>'+escapeHtml(p.mountpoint)+'</td><td>'+escapeHtml(p.fstype)+'</td><td>'+us+'</td></tr>';
        });
    }

    // ==================== SMART ====================
    function refreshSmart() {
        if (!selectedDisk) return;
        var ld = document.getElementById('smartLoading'), ct = document.getElementById('smartContent');
        if (ld) ld.style.display = 'flex'; if (ct) ct.style.display = 'none';
        // 刷新按钮强制获取最新数据
        whenAll([getSmartHealth(selectedDisk), getSmartAttrs(selectedDisk), getErrorLog(selectedDisk)]).then(function(r) {
            setCachedDisk(selectedDisk, { health: r[0], smartAttrs: r[1], errors: r[2] });
            var hb = document.getElementById('smartHealthBadge');
            if (hb) { hb.className = ''; hb.style.fontWeight = '700'; hb.style.color = r[0]==='passed'?'var(--success)':r[0]==='failed'?'var(--danger)':'var(--warning)'; hb.textContent = r[0]==='passed'?t('smartPassed'):r[0]==='failed'?t('smartFailed'):t('smartUnknown'); }
            var tbody = document.getElementById('smartAttrTableBody');
            if (tbody) {
                if (r[1].length===0) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">-</td></tr>';
                else { tbody.innerHTML = ''; r[1].forEach(function(a) { var rc = a.status==='bad'?'smart-row-bad':a.status==='warn'?'smart-row-warn':'smart-row-good'; var sc = a.status==='bad'?'var(--danger)':a.status==='warn'?'var(--warning)':'var(--success)'; var st = '<span style="color:'+sc+';font-weight:600">' + (a.status==='bad'?'FAIL':a.status==='warn'?'WARN':'OK') + '</span>'; tbody.innerHTML += '<tr class="'+rc+'"><td>'+a.id+'</td><td>'+escapeHtml(a.name)+'</td><td>'+a.value+'</td><td>'+a.worst+'</td><td>'+a.thresh+'</td><td style="font-family:var(--font-mono)">'+escapeHtml(a.raw)+'</td><td>'+st+'</td></tr>'; }); }
            }
            var ec = document.getElementById('smartErrorCount'); if (ec) ec.textContent = r[2].count;
            var el = document.getElementById('smartErrorList');
            if (el) el.innerHTML = r[2].count===0?'<div class="alert-banner alert-success"><span class="alert-msg">'+t('smartNoErrors')+'</span></div>':'';
            if (ld) ld.style.display = 'none'; if (ct) ct.style.display = 'block';
        });
    }

    // ==================== Hibernation ====================
    var hibTimer = null;
    var hibHistoryPage = 0;
    var HIB_HISTORY_PER_PAGE = 20;
    function refreshHib() {
        if (!selectedDisk) return;
        // 清除旧的刷新定时器
        if (hibTimer) { clearInterval(hibTimer); hibTimer = null; }
        // 先刷新后端缓存数据，再查询磁盘状态
        refreshBackendCache().then(function() {
        // hdparm -C 不会唤醒磁盘，直接查询实时状态
        var hibPromise = getHibState(selectedDisk);
        return whenAll([
            hibPromise,
            getApm(selectedDisk),
            getWriteCache(selectedDisk)
        ]).then(function(r) {
            var s = r[0].state;
            var apm = r[1];
            var cache = r[2];

            // 状态 badge
            var b = document.getElementById('hibStateBadge');
            if (b) {
                b.style.fontWeight = '700';
                if (s === 'active') { b.style.color = 'var(--success)'; b.textContent = t('hibernateActive'); }
                else if (s === 'standby') { b.style.color = 'var(--warning)'; b.textContent = t('hibernateStandby'); }
                else if (s === 'sleep') { b.style.color = 'var(--warning)'; b.textContent = t('hibernateSleeping'); }
                else if (s === 'virtual') { b.style.color = 'var(--text-tertiary)'; b.textContent = 'ZFS zvol'; }
                else { b.style.color = 'var(--text-tertiary)'; b.textContent = t('hibernateUnknown'); }
            }

            // 显示运行时长 / 休眠时长（和仪表盘一致）
            var labelEl = document.getElementById('hibDurationLabel');
            var durEl = document.getElementById('hibDurationValue');
            var now = Date.now();

            if (s === 'standby' || s === 'sleep') {
                // 休眠状态：显示休眠时长，黄色
                // 如果后端尚未记录 standbySince，本地设置（后端会随后覆盖）
                if (!backendDataCache.standbySince[selectedDisk]) {
                    backendDataCache.standbySince[selectedDisk] = now;
                }
                // 清除 activeSince（磁盘已休眠）
                if (backendDataCache.activeSince[selectedDisk]) {
                    delete backendDataCache.activeSince[selectedDisk];
                }
                if (labelEl) { labelEl.textContent = t('hibernateStandbyDuration'); labelEl.style.color = 'var(--warning)'; }
                if (durEl) {
                    durEl.style.color = 'var(--warning)';
                    durEl.textContent = formatDuration(now - backendDataCache.standbySince[selectedDisk]);
                }
            } else {
                // 活动状态：显示唤醒/开机后的运行时长，绿色
                // 如果有残留的 standbySince，清除并设置 activeSince（磁盘已唤醒）
                if (backendDataCache.standbySince[selectedDisk]) {
                    delete backendDataCache.standbySince[selectedDisk];
                }
                if (!backendDataCache.activeSince[selectedDisk]) {
                    backendDataCache.activeSince[selectedDisk] = now;
                }
                if (labelEl) { labelEl.textContent = t('hibernateUptime'); labelEl.style.color = 'var(--success)'; }
                if (durEl) {
                    durEl.style.color = 'var(--success)';
                    durEl.textContent = formatDuration(Date.now() - backendDataCache.activeSince[selectedDisk]);
                }
            }

            // APM 卡片：始终显示，不支持时显示提示
            var apmCard = document.getElementById('hibApmCard');
            if (apmCard) {
                apmCard.style.display = '';
                var apmInput = document.getElementById('hibApmInput');
                var apmCheck = document.getElementById('hibApmCheck');
                var apmApplyBtn = document.getElementById('btnSetApm');
                
                if (apm.supported) {
                    // 支持 APM
                    if (apmInput) {
                        apmInput.disabled = false;
                        apmInput.value = apm.level > 0 && apm.level < 255 ? apm.level : 128;
                        // 根据开关状态显示/隐藏输入框（编辑时不覆盖）
                        if (!apmEditing) {
                            apmInput.style.display = apm.enabled ? '' : 'none';
                        }
                    }
                    if (apmCheck) {
                        apmCheck.disabled = false;
                        // 编辑状态时不覆盖用户修改
                        if (!apmEditing) {
                            apmCheck.checked = apm.enabled;
                        }
                    }
                    if (apmApplyBtn) apmApplyBtn.disabled = false;
                    // 移除不支持提示
                    var notSupportedHint = apmCard.querySelector('.apm-not-supported');
                    if (notSupportedHint) notSupportedHint.remove();
                } else {
                    // 不支持 APM
                    if (apmInput) {
                        apmInput.disabled = true;
                        apmInput.style.display = 'none';
                    }
                    if (apmCheck) {
                        apmCheck.disabled = true;
                        apmCheck.checked = false;
                    }
                    if (apmApplyBtn) apmApplyBtn.disabled = true;
                    // 添加不支持提示
                    var existingHint = apmCard.querySelector('.apm-not-supported');
                    if (!existingHint) {
                        var hint = document.createElement('p');
                        hint.className = 'apm-not-supported';
                        hint.style.cssText = 'margin-bottom:16px;color:var(--warning);font-size:0.82rem;font-weight:600;';
                        hint.textContent = t('hibernateApmNotSupported') || '此硬盘不支持 APM';
                        var cardH2 = apmCard.querySelector('h2');
                        if (cardH2 && cardH2.nextSibling) {
                            apmCard.insertBefore(hint, cardH2.nextSibling);
                        }
                    }
                }
            }

            // 缓存卡片：不支持时隐藏
            var cacheCard = document.getElementById('hibCacheCard');
            if (cacheCard) {
                if (cache.supported) {
                    cacheCard.style.display = '';
                    var cacheCheck = document.getElementById('hibWriteCacheCheck');
                    // 编辑状态时不覆盖用户修改
                    if (cacheCheck && !cacheEditing) {
                        cacheCheck.checked = cache.enabled;
                    }
                } else {
                    cacheCard.style.display = 'none';
                }
            }

            // 启动定时器，每秒刷新时长显示
            hibTimer = setInterval(function() {
                var durEl = document.getElementById('hibDurationValue');
                if (!durEl) return;
                if (s === 'standby' || s === 'sleep') {
                    if (backendDataCache.standbySince[selectedDisk]) {
                        durEl.textContent = formatDuration(Date.now() - backendDataCache.standbySince[selectedDisk]);
                    }
                } else {
                    if (backendDataCache.activeSince[selectedDisk]) {
                        durEl.textContent = formatDuration(Date.now() - backendDataCache.activeSince[selectedDisk]);
                    }
                }
            }, 1000);

            // 渲染状态变更历史
            renderHibHistory();
        });
        }); // close refreshBackendCache().then()
    }

    // ==================== Hibernation History ====================
    
    function formatTimestamp(ms) {
        if (!ms) return '-';
        var d = new Date(ms);
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function stateLabel(s) {
        if (s === 'active') return t('hibernateActive');
        if (s === 'standby') return t('hibernateStandby');
        if (s === 'sleep') return t('hibernateSleeping');
        return s || '-';
    }
    function renderHibHistory() {
        // 清除旧的实时刷新定时器
        if (hibHistoryLiveTimer) { clearInterval(hibHistoryLiveTimer); hibHistoryLiveTimer = null; }
        
        // 只显示当前选中硬盘的记录
        var allHistory = (backendDataCache.stateHistory || appData.stateHistory || []).slice();
        var history = selectedDisk ? allHistory.filter(function(r) { return r.device === selectedDisk; }) : allHistory;
        
        // 排序
        if (hibHistorySortAsc) {
            history.sort(function(a, b) { return a.startTime - b.startTime; });
        } else {
            history.sort(function(a, b) { return b.startTime - a.startTime; });
        }
        
        var total = history.length;
        var totalPages = Math.max(1, Math.ceil(total / HIB_HISTORY_PER_PAGE));
        if (hibHistoryPage >= totalPages) hibHistoryPage = totalPages - 1;
        if (hibHistoryPage < 0) hibHistoryPage = 0;

        var start = hibHistoryPage * HIB_HISTORY_PER_PAGE;
        var page = history.slice(start, start + HIB_HISTORY_PER_PAGE);

        // 获取磁盘型号（优先从缓存，其次从仪表盘表格）
        var diskModel = '-';
        var cached = getCachedDisk(selectedDisk);
        if (cached && cached.info && cached.info.deviceModel) {
            diskModel = cached.info.deviceModel;
        } else {
            // 从仪表盘表格获取型号
            var dashRow = document.querySelector('#dashDiskTableBody tr td strong');
            if (dashRow && dashRow.textContent) {
                // 遍历表格查找对应磁盘
                var rows = document.querySelectorAll('#dashDiskTableBody tr');
                for (var i = 0; i < rows.length; i++) {
                    var nameCell = rows[i].querySelector('td strong');
                    var modelCell = rows[i].querySelector('td:nth-child(2)');
                    if (nameCell && modelCell && nameCell.textContent === selectedDisk) {
                        diskModel = modelCell.textContent;
                        break;
                    }
                }
            }
        }

        // 获取当前状态
        var currentState = null;
        var currentStateStart = null;
        if (backendDataCache.standbySince && backendDataCache.standbySince[selectedDisk]) {
            currentState = 'standby';
            currentStateStart = backendDataCache.standbySince[selectedDisk];
        } else if (backendDataCache.activeSince && backendDataCache.activeSince[selectedDisk]) {
            currentState = 'active';
            currentStateStart = backendDataCache.activeSince[selectedDisk];
        }

        var tbody = document.getElementById('hibHistoryBody');
        if (tbody) {
            if (page.length === 0 && !currentState) {
                tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><div class="empty-text">' + t('hibernateHistoryEmpty') + '</div></td></tr>';
            } else {
                tbody.innerHTML = '';
                
                // 创建当前状态行的函数
                function createLiveRow() {
                    if (!currentState || !currentStateStart) return null;
                    var now = Date.now();
                    var liveStateColor = currentState === 'active' ? 'var(--success)' : 'var(--warning)';
                    var liveRow = document.createElement('tr');
                    liveRow.id = 'hibHistoryLiveRow';
                    liveRow.style.background = 'var(--accent-light)';
                    liveRow.innerHTML = '<td style="color:' + liveStateColor + ';font-weight:600">' + escapeHtml(stateLabel(currentState)) + ' <span style="font-size:0.75rem;opacity:0.7;">(当前)</span></td>' +
                        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + formatTimestamp(currentStateStart) + '</td>' +
                        '<td style="font-family:var(--font-mono);font-size:0.82rem;color:var(--text-tertiary)">-</td>' +
                        '<td id="hibHistoryLiveDuration">' + escapeHtml(formatDuration(now - currentStateStart)) + '</td>';
                    return liveRow;
                }
                
                // 倒序（新→旧）：当前行在最前
                if (!hibHistorySortAsc) {
                    var liveRow = createLiveRow();
                    if (liveRow) {
                        tbody.appendChild(liveRow);
                        // 启动实时刷新定时器
                        hibHistoryLiveTimer = setInterval(function() {
                            var durEl = document.getElementById('hibHistoryLiveDuration');
                            if (durEl && currentStateStart) {
                                durEl.textContent = formatDuration(Date.now() - currentStateStart);
                            }
                        }, 1000);
                    }
                }
                
                // 历史记录：状态显示开始时间的状态（fromState）
                page.forEach(function(r) {
                    var stateColor = r.fromState === 'active' ? 'var(--success)' : 'var(--warning)';
                    var tr = document.createElement('tr');
                    tr.innerHTML = '<td style="color:' + stateColor + ';font-weight:600">' + escapeHtml(stateLabel(r.fromState)) + '</td>' +
                        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + formatTimestamp(r.startTime) + '</td>' +
                        '<td style="font-family:var(--font-mono);font-size:0.82rem">' + formatTimestamp(r.endTime) + '</td>' +
                        '<td>' + escapeHtml(formatDuration(r.duration)) + '</td>';
                    tbody.appendChild(tr);
                });
                
                // 正序（旧→新）：当前行在最后
                if (hibHistorySortAsc) {
                    var liveRow = createLiveRow();
                    if (liveRow) {
                        tbody.appendChild(liveRow);
                        // 启动实时刷新定时器
                        hibHistoryLiveTimer = setInterval(function() {
                            var durEl = document.getElementById('hibHistoryLiveDuration');
                            if (durEl && currentStateStart) {
                                durEl.textContent = formatDuration(Date.now() - currentStateStart);
                            }
                        }, 1000);
                    }
                }
            }
        }

        // 更新表格标题，显示磁盘路径和型号 + 排序按钮
        var historyCard = document.getElementById('hibHistoryCard');
        if (historyCard) {
            var h2 = historyCard.querySelector('h2');
            if (h2) {
                var sortIcon = hibHistorySortAsc 
                    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:middle;"><path d="M12 5v14M5 12l7-7 7 7"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:middle;"><path d="M12 19V5M5 12l7 7 7-7"/></svg>';
                h2.innerHTML = '<span style="display:flex;align-items:center;gap:8px;">' + 
                    '<span>' + t('hibernateHistory') + '</span>' +
                    '<span style="font-size:0.85rem;font-weight:400;color:var(--text-tertiary);">' + escapeHtml(selectedDisk || '-') + (diskModel !== '-' ? ' (' + escapeHtml(diskModel) + ')' : '') + '</span>' +
                    '</span>' +
                    '<button id="hibHistorySortBtn" class="btn btn-secondary btn-sm" style="margin-left:auto;padding:4px 10px;" title="' + (hibHistorySortAsc ? '正序' : '倒序') + '">' + sortIcon + '</button>';
                h2.style.display = 'flex';
                h2.style.alignItems = 'center';
                
                var sortBtn = document.getElementById('hibHistorySortBtn');
                if (sortBtn) {
                    sortBtn.addEventListener('click', function() {
                        hibHistorySortAsc = !hibHistorySortAsc;
                        hibHistoryPage = 0;
                        renderHibHistory();
                    });
                }
            }
        }

        // 分页控件
        var pag = document.getElementById('hibHistoryPagination');
        if (pag) {
            if (totalPages <= 1) {
                pag.innerHTML = total > 0 ? '<span style="color:var(--text-tertiary);font-size:0.82rem;">' + t('hibernateHistoryTotal', {count: total}) + '</span>' : '';
            } else {
                pag.innerHTML =
                    '<button class="btn btn-secondary btn-sm" id="hibHistPrev" ' + (hibHistoryPage <= 0 ? 'disabled' : '') + '>' + t('btnPrev') + '</button>' +
                    '<span style="color:var(--text-tertiary);font-size:0.82rem;">' + (hibHistoryPage + 1) + ' / ' + totalPages + ' (' + t('hibernateHistoryTotal', {count: total}) + ')</span>' +
                    '<button class="btn btn-secondary btn-sm" id="hibHistNext" ' + (hibHistoryPage >= totalPages - 1 ? 'disabled' : '') + '>' + t('btnNext') + '</button>';
                var prevBtn = document.getElementById('hibHistPrev');
                var nextBtn = document.getElementById('hibHistNext');
                if (prevBtn) prevBtn.addEventListener('click', function() { hibHistoryPage--; renderHibHistory(); });
                if (nextBtn) nextBtn.addEventListener('click', function() { hibHistoryPage++; renderHibHistory(); });
            }
        }
    }

    // ==================== IO Monitor ====================
    function startIoMonitor() {
        ioHistory = {};
        var diskName = selectedDisk.replace('/dev/', '');
        ioListeners = [function(snapshot) { renderIoStats(snapshot, diskName); }];
        // 读取保存的刷新间隔
        var sel = document.getElementById('ioRefreshSelect');
        if (sel) {
            if (state.ioInterval) sel.value = state.ioInterval;
            ioInterval = parseInt(sel.value) || 1000;
        }
        IoMonitor_start();
        // 从磁盘列表获取型号并缓存
        getDiskList().then(function(disks) {
            disks.forEach(function(d) {
                var dev = d.name.replace('/dev/', '');
                ioDiskModels[dev] = d.model || '-';
            });
        });
    }
    function renderIoStats(snapshot, diskName) {
        var d = snapshot.delta[diskName];
        var el;
        el = document.getElementById('ioReadSpeed'); if (el) el.textContent = d ? formatSpeed(d.readBps) : '-';
        el = document.getElementById('ioWriteSpeed'); if (el) el.textContent = d ? formatSpeed(d.writeBps) : '-';
        el = document.getElementById('ioUtilization'); if (el) el.textContent = d ? d.ioUtil.toFixed(1) + '%' : '-';
        el = document.getElementById('ioIops'); if (el) el.textContent = d ? Math.round(d.readIops + d.writeIops) : '-';
        var tbody = document.getElementById('ioPerDiskBody');
        if (tbody) {
            // 清除初始 loading spinner（如果还在）
            var loadingRow = tbody.querySelector('.loading-overlay');
            if (loadingRow) loadingRow.closest('tr').remove();

            // 如果没有磁盘数据，显示空状态
            if (Object.keys(snapshot.delta).length === 0) {
                if (!tbody.querySelector('.empty-state')) {
                    tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><div class="empty-text">' + t('ioNoData') + '</div></td></tr>';
                }
                return;
            }
            // 分离磁盘和分区
            var disks = {}, partitions = {};
            for (var dev in snapshot.delta) {
                var isPart = dev.match(/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+|xvd[a-z]+)(p?\d+)$/i);
                if (isPart) {
                    var parent = isPart[1];
                    if (!partitions[parent]) partitions[parent] = [];
                    partitions[parent].push(dev);
                } else {
                    disks[dev] = snapshot.delta[dev];
                }
            }

            // 增量更新：如果行已存在就更新数据，否则创建
            var existingRows = {};
            tbody.querySelectorAll('.io-disk-row').forEach(function(tr) { existingRows[tr.getAttribute('data-disk')] = tr; });

            // 移除不再存在的磁盘行及其分区行
            for (var oldDev in existingRows) {
                if (!disks[oldDev]) {
                    tbody.querySelectorAll('[data-parent="' + oldDev + '"]').forEach(function(r) { r.remove(); });
                    existingRows[oldDev].remove();
                    delete existingRows[oldDev];
                }
            }

            for (var diskDev in disks) {
                var dd = snapshot.delta[diskDev];
                var model = ioDiskModels[diskDev] || '-';
                var hasParts = partitions[diskDev] && partitions[diskDev].length > 0;
                var expanded = !!ioExpandedDisks[diskDev];
                var expandSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;display:inline-block;vertical-align:middle;transition:transform 0.2s ease;' + (expanded ? 'transform:rotate(90deg)' : '') + '"><path d="M6 4l4 4-4 4"/></svg>';
                var expandIcon = hasParts ? ' <span style="cursor:pointer;opacity:0.7;display:inline-flex;align-items:center;" data-expand="' + diskDev + '">' + expandSvg + '</span>' : '';

                var row = existingRows[diskDev];
                if (row) {
                    // 更新已有行
                    row.innerHTML = '<td><strong>/dev/' + escapeHtml(diskDev) + '</strong>' + expandIcon + '</td>' +
                        '<td>' + escapeHtml(model) + '</td>' +
                        '<td style="font-family:var(--font-mono)">' + formatSpeed(dd.readBps) + '</td>' +
                        '<td style="font-family:var(--font-mono)">' + formatSpeed(dd.writeBps) + '</td>' +
                        '<td>' + Math.round(dd.readIops) + '</td>' +
                        '<td>' + Math.round(dd.writeIops) + '</td>' +
                        '<td>' + dd.ioUtil.toFixed(1) + '%</td>';
                    // 更新分区行
                    if (hasParts) {
                        partitions[diskDev].forEach(function(partDev) {
                            var partRow = tbody.querySelector('.io-part-row[data-parent="' + diskDev + '"][data-part="' + partDev + '"]');
                            var pd = snapshot.delta[partDev];
                            if (!partRow) {
                                partRow = document.createElement('tr');
                                partRow.className = 'io-part-row';
                                partRow.setAttribute('data-parent', diskDev);
                                partRow.setAttribute('data-part', partDev);
                                // 插入到磁盘行后面
                                var nextSib = row.nextSibling;
                                tbody.insertBefore(partRow, nextSib);
                            }
                            partRow.style.display = expanded ? '' : 'none';
                            partRow.innerHTML = '<td style="padding-left:28px;color:var(--text-tertiary)">└ /dev/' + escapeHtml(partDev) + '</td>' +
                                '<td>-</td>' +
                                '<td style="font-family:var(--font-mono)">' + formatSpeed(pd.readBps) + '</td>' +
                                '<td style="font-family:var(--font-mono)">' + formatSpeed(pd.writeBps) + '</td>' +
                                '<td>' + Math.round(pd.readIops) + '</td>' +
                                '<td>' + Math.round(pd.writeIops) + '</td>' +
                                '<td>' + pd.ioUtil.toFixed(1) + '%</td>';
                            partRow.style.cursor = 'pointer';
                            partRow.onclick = function() { openIoDetail(partDev); };
                        });
                    }
                } else {
                    // 创建新行
                    var tr = document.createElement('tr');
                    tr.className = 'io-disk-row';
                    tr.setAttribute('data-disk', diskDev);
                    tr.style.cursor = 'pointer';
                    tr.innerHTML = '<td><strong>/dev/' + escapeHtml(diskDev) + '</strong>' + expandIcon + '</td>' +
                        '<td>' + escapeHtml(model) + '</td>' +
                        '<td style="font-family:var(--font-mono)">' + formatSpeed(dd.readBps) + '</td>' +
                        '<td style="font-family:var(--font-mono)">' + formatSpeed(dd.writeBps) + '</td>' +
                        '<td>' + Math.round(dd.readIops) + '</td>' +
                        '<td>' + Math.round(dd.writeIops) + '</td>' +
                        '<td>' + dd.ioUtil.toFixed(1) + '%</td>';
                    tbody.appendChild(tr);
                    // 分区行
                    if (hasParts) {
                        partitions[diskDev].forEach(function(partDev) {
                            var pd = snapshot.delta[partDev];
                            var pr = document.createElement('tr');
                            pr.className = 'io-part-row';
                            pr.setAttribute('data-parent', diskDev);
                            pr.setAttribute('data-part', partDev);
                            pr.style.display = expanded ? '' : 'none';
                            pr.style.cursor = 'pointer';
                            pr.innerHTML = '<td style="padding-left:28px;color:var(--text-tertiary)">└ /dev/' + escapeHtml(partDev) + '</td>' +
                                '<td>-</td>' +
                                '<td style="font-family:var(--font-mono)">' + formatSpeed(pd.readBps) + '</td>' +
                                '<td style="font-family:var(--font-mono)">' + formatSpeed(pd.writeBps) + '</td>' +
                                '<td>' + Math.round(pd.readIops) + '</td>' +
                                '<td>' + Math.round(pd.writeIops) + '</td>' +
                                '<td>' + pd.ioUtil.toFixed(1) + '%</td>';
                            tbody.appendChild(pr);
                            pr.onclick = (function(dev) { return function() { openIoDetail(dev); }; })(partDev);
                        });
                    }
                    tr.addEventListener('click', function() { openIoDetail(tr.getAttribute('data-disk')); });
                }
            }
            // 绑定展开/折叠事件
            tbody.querySelectorAll('[data-expand]').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var disk = btn.getAttribute('data-expand');
                    ioExpandedDisks[disk] = !ioExpandedDisks[disk];
                    var rows = tbody.querySelectorAll('.io-part-row[data-parent="' + disk + '"]');
                    rows.forEach(function(r) { r.style.display = ioExpandedDisks[disk] ? '' : 'none'; });
                    var svg = btn.querySelector('svg');
                    if (svg) svg.style.transform = ioExpandedDisks[disk] ? 'rotate(90deg)' : '';
                });
            });
        }
        drawIoChart(snapshot.history);
    }
    function drawIoChart(history) {
        var canvas = document.getElementById('ioChart'); if (!canvas) return;
        var ctx = canvas.getContext('2d'); var rect = canvas.parentElement.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
        ctx.scale(dpr, dpr); var W = rect.width, H = rect.height;
        ctx.clearRect(0, 0, W, H);

        // 汇总所有磁盘数据
        var allTimestamps = {};
        for (var dev in history) {
            history[dev].forEach(function(h) { allTimestamps[h.timestamp] = true; });
        }
        var timestamps = Object.keys(allTimestamps).map(Number).sort();
        if (timestamps.length < 2) { ctx.fillStyle = '#718096'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(t('ioNoData'), W/2, H/2); return; }

        // 按时间戳汇总
        var agg = timestamps.map(function(ts) {
            var r = 0, w = 0;
            for (var d in history) {
                var entry = history[d].find(function(h) { return h.timestamp === ts; });
                if (entry) { r += entry.readBps; w += entry.writeBps; }
            }
            return { timestamp: ts, readBps: r, writeBps: w };
        });

        var maxVal = 1;
        agg.forEach(function(h) { maxVal = Math.max(maxVal, h.readBps, h.writeBps); });
        maxVal *= 1.1;

        var pad = {top:20,right:20,bottom:30,left:60}, cW = W-pad.left-pad.right, cH = H-pad.top-pad.bottom;
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5;
        for (var i = 0; i <= 4; i++) { var y = pad.top + cH*(1-i/4); ctx.beginPath(); ctx.moveTo(pad.left,y); ctx.lineTo(W-pad.right,y); ctx.stroke(); ctx.fillStyle = '#718096'; ctx.font = '11px monospace'; ctx.textAlign = 'right'; ctx.fillText(formatSpeed(maxVal*i/4), pad.left-8, y+4); }
        ctx.strokeStyle = '#3182ce'; ctx.lineWidth = 2; ctx.beginPath();
        agg.forEach(function(h,idx) { var x = pad.left+(idx/(agg.length-1))*cW, y = pad.top+cH*(1-h.readBps/maxVal); if(idx===0)ctx.moveTo(x,y);else ctx.lineTo(x,y); }); ctx.stroke();
        ctx.strokeStyle = '#38a169'; ctx.lineWidth = 2; ctx.beginPath();
        agg.forEach(function(h,idx) { var x = pad.left+(idx/(agg.length-1))*cW, y = pad.top+cH*(1-h.writeBps/maxVal); if(idx===0)ctx.moveTo(x,y);else ctx.lineTo(x,y); }); ctx.stroke();
        var ly = H-10; ctx.fillStyle='#3182ce'; ctx.fillRect(pad.left,ly-6,12,3); ctx.fillStyle='#718096'; ctx.font='11px sans-serif'; ctx.textAlign='left'; ctx.fillText('Read',pad.left+16,ly);
        ctx.fillStyle='#38a169'; ctx.fillRect(pad.left+70,ly-6,12,3); ctx.fillStyle='#718096'; ctx.fillText('Write',pad.left+86,ly);
    }

    // ==================== IO Detail Modal ====================
    var ioDetailTimer = null, ioDetailDev = null, ioDetailRangeSec = 60;

    function drawMiniChart(canvasId, hist, key, color, maxVal, formatFn) {
        var canvas = document.getElementById(canvasId); if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var rect = canvas.parentElement.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
        ctx.scale(dpr, dpr); var W = rect.width, H = rect.height;
        ctx.clearRect(0, 0, W, H);
        if (hist.length < 2) { ctx.fillStyle = '#718096'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(t('ioNoData'), W/2, H/2); return; }
        var pad = {top:12,right:12,bottom:24,left:52}, cW = W-pad.left-pad.right, cH = H-pad.top-pad.bottom;
        // grid
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5;
        for (var i = 0; i <= 3; i++) { var y = pad.top+cH*(1-i/3); ctx.beginPath(); ctx.moveTo(pad.left,y); ctx.lineTo(W-pad.right,y); ctx.stroke(); ctx.fillStyle='#718096'; ctx.font='10px monospace'; ctx.textAlign='right'; ctx.fillText(formatFn(maxVal*i/3), pad.left-6, y+3); }
        // line
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
        hist.forEach(function(h,idx) { var x = pad.left+(idx/(hist.length-1))*cW, y = pad.top+cH*(1-(h[key]||0)/maxVal); if(idx===0)ctx.moveTo(x,y);else ctx.lineTo(x,y); }); ctx.stroke();
        // fill
        ctx.lineTo(pad.left+cW, pad.top+cH); ctx.lineTo(pad.left, pad.top+cH); ctx.closePath();
        ctx.fillStyle = color.replace(')', ',0.1)').replace('rgb', 'rgba'); ctx.fill();
    }

    function ioDetailRefresh() {
        if (!ioDetailDev) return;
        var hist = ioHistory[ioDetailDev] || [];
        // 按时间范围裁剪
        var now = Date.now(), cutoff = now - ioDetailRangeSec * 1000;
        var slice = hist.filter(function(h) { return h.timestamp >= cutoff; });
        var maxSpeed = 1, maxIops = 1;
        slice.forEach(function(h) { maxSpeed = Math.max(maxSpeed, h.readBps, h.writeBps); maxIops = Math.max(maxIops, h.readIops, h.writeIops); });
        maxSpeed *= 1.1; maxIops *= 1.1;
        drawMiniChart('ioDetailReadSpeed', slice, 'readBps', 'rgb(49,130,206)', maxSpeed, formatSpeed);
        drawMiniChart('ioDetailWriteSpeed', slice, 'writeBps', 'rgb(56,161,105)', maxSpeed, formatSpeed);
        drawMiniChart('ioDetailReadIops', slice, 'readIops', 'rgb(136,99,208)', maxIops, function(v) { return Math.round(v); });
        drawMiniChart('ioDetailWriteIops', slice, 'writeIops', 'rgb(219,130,68)', maxIops, function(v) { return Math.round(v); });
    }

    function openIoDetail(dev) {
        ioDetailDev = dev;
        document.getElementById('ioDetailTitle').textContent = '/dev/' + dev + ' I/O';
        document.getElementById('ioDetailOverlay').classList.add('show');
        document.body.style.overflow = 'hidden';
        // 等模态框动画完成再画图，确保 canvas 有尺寸
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                ioDetailRefresh();
                // 刷新间隔跟页面一致
                ioDetailTimer = setInterval(ioDetailRefresh, ioInterval);
            });
        });
    }
    function closeIoDetail() {
        document.getElementById('ioDetailOverlay').classList.remove('show');
        document.body.style.overflow = '';
        if (ioDetailTimer) { clearInterval(ioDetailTimer); ioDetailTimer = null; }
        ioDetailDev = null;
    }

    // ==================== Self Test ====================
    var selfTestTimer = null;
    
    function refreshSelfTest() {
        if (!selectedDisk) return;
        // 清除旧的轮询定时器
        if (selfTestTimer) { clearInterval(selfTestTimer); selfTestTimer = null; }
        
        whenAll([getSelfTestStatus(selectedDisk), getSelfTestLog(selectedDisk)]).then(function(r) {
            var b = document.getElementById('selfTestStatusBadge');
            var abortSection = document.getElementById('selfTestAbortSection');
            
            if (b) { b.style.fontWeight='700'; if (r[0].running) { b.style.color='var(--info)'; b.textContent=t('selfTestRunning')+(r[0].type?' ('+r[0].type+')':'')+(r[0].remaining?' '+r[0].remaining:''); } else { b.style.color='var(--text-tertiary)'; b.textContent=t('selfTestIdle'); } }
            
            // 根据测试状态显示/隐藏中止按钮
            if (abortSection) {
                abortSection.style.display = r[0].running ? '' : 'none';
            }
            
            var tbody = document.getElementById('selfTestLogBody');
            if (tbody) { if(r[1].entries.length===0) tbody.innerHTML='<tr><td colspan="4" class="empty-state"><div class="empty-text">'+t('smartNoSelfTests')+'</div></td></tr>'; else { tbody.innerHTML=''; r[1].entries.forEach(function(e) { var passed = e.status.indexOf('without error')!==-1; var sc = passed?'var(--success)':'var(--danger)'; var st = '<span style="color:'+sc+';font-weight:600">' + escapeHtml(e.status) + '</span>'; tbody.innerHTML+='<tr><td>'+e.num+'</td><td>'+escapeHtml(e.description)+'</td><td>'+st+'</td><td>'+escapeHtml(e.lifetime)+'</td></tr>'; }); } }
            
            // 如果测试正在运行，启动轮询
            if (r[0].running) {
                startSelfTestPolling();
            }
        });
    }
    
    function startSelfTestPolling() {
        if (selfTestTimer) return;
        selfTestTimer = setInterval(function() {
            if (!selectedDisk) {
                clearInterval(selfTestTimer);
                selfTestTimer = null;
                return;
            }
            getSelfTestStatus(selectedDisk).then(function(status) {
                var b = document.getElementById('selfTestStatusBadge');
                var abortSection = document.getElementById('selfTestAbortSection');
                
                if (b) {
                    b.style.fontWeight = '700';
                    if (status.running) {
                        b.style.color = 'var(--info)';
                        b.textContent = t('selfTestRunning') + 
                            (status.type ? ' (' + status.type + ')' : '') + 
                            (status.remaining ? ' ' + status.remaining : '');
                    } else {
                        b.style.color = 'var(--success)';
                        b.textContent = t('selfTestCompleted') || '测试完成';
                        // 测试完成，停止轮询并刷新日志
                        clearInterval(selfTestTimer);
                        selfTestTimer = null;
                        // 隐藏中止按钮
                        if (abortSection) abortSection.style.display = 'none';
                        setTimeout(refreshSelfTest, 1000);
                    }
                }
                
                // 根据测试状态显示/隐藏中止按钮
                if (abortSection) {
                    abortSection.style.display = status.running ? '' : 'none';
                }
            });
        }, 3000);
    }
    function startSelfTest(type) {
        if (!selectedDisk) { showToast(t('diskNoDisk'), 'warning'); return; }
        showToast(t('selfTestStarting') || '正在启动测试...', 'info', 2);
        runCmd(['smartctl', '-t', type, selectedDisk], { superuser: 'require', err: 'out' }).then(function(r) {
            if (cmdOk(r)) {
                showToast(t('toastOperationSuccess'), 'success');
                // 立即刷新状态并启动轮询
                setTimeout(function() {
                    refreshSelfTest();
                }, 1000);
            } else {
                var err = cmdErr(r);
                var msg = (err && err.message) ? err.message : (typeof err === 'string' ? err : t('toastOperationFailed'));
                // 检查是否是权限问题
                if (msg.indexOf('Permission') !== -1 || msg.indexOf('denied') !== -1 || msg.indexOf('root') !== -1) {
                    msg = t('toastNeedRoot');
                }
                showToast(msg, 'error', 5);
            }
        });
    }
    function abortSelfTest() {
        if (!selectedDisk) { showToast(t('diskNoDisk'), 'warning'); return; }
        runCmd(['smartctl', '-X', selectedDisk]).then(function(r) {
            if (cmdOk(r)) {
                showToast(t('toastOperationSuccess'), 'success');
                setTimeout(refreshSelfTest, 2000);
            } else {
                var err = cmdErr(r);
                var msg = (err && err.message) ? err.message : (typeof err === 'string' ? err : t('toastOperationFailed'));
                showToast(msg, 'error');
            }
        });
    }

    // ==================== Custom Selects ====================
    function initCustomSelects() {
        document.querySelectorAll('.custom-select').forEach(function(cs) {
            var trigger = cs.querySelector('.custom-select-trigger'), options = cs.querySelectorAll('.custom-select-option');
            if (!trigger) return;
            trigger.addEventListener('click', function(e) { e.stopPropagation(); document.querySelectorAll('.custom-select.open').forEach(function(o) { if(o!==cs)o.classList.remove('open'); }); cs.classList.toggle('open'); });
            options.forEach(function(opt) {
                opt.addEventListener('click', function() {
                    options.forEach(function(o) { o.classList.remove('selected'); }); opt.classList.add('selected');
                    cs.querySelector('.custom-select-value').textContent = opt.textContent; cs.classList.remove('open');
                    onCustomSelectChange(cs.dataset.field, opt.dataset.value);
                });
            });
        });
        document.addEventListener('click', function() { document.querySelectorAll('.custom-select.open').forEach(function(cs) { cs.classList.remove('open'); }); });
    }
    function onCustomSelectChange(field, value) {
        if (field === 'settingTheme') applyTheme(value);
        else if (field === 'settingLang') {
            currentLang = value; state.lang = value; $html.lang = value; saveState();
            loadLang(value).then(function() { updateAllI18n(); buildMenus(); setActiveMenu('dashboard'); });
            showToast(t('toastLangChanged'), 'success', 2.5);
        }
        else if (field === 'settingMenuLayout') { state.menuLayout = value; saveState(); applyEffectiveLayout(getEffectiveLayout()); updateLayoutIcons(); buildMenus(); setActiveMenu('dashboard'); showToast(t('toastMenuLayoutChanged'), 'success', 2.5); }
    }
    function setCustomSelectValue(field, value) {
        var el = document.querySelector('.custom-select[data-field="'+field+'"]'); if (!el) return;
        el.querySelectorAll('.custom-select-option').forEach(function(opt) { var is = opt.dataset.value===value; opt.classList.toggle('selected', is); if(is) el.querySelector('.custom-select-value').textContent = opt.textContent; });
    }

    // ==================== Settings ====================
    function openSettings() {
        setCustomSelectValue('settingTheme', currentTheme); setCustomSelectValue('settingLang', currentLang);
        setCustomSelectValue('settingMenuLayout', state.menuLayout);
        var ri = document.getElementById('settingRefreshInterval'); if (ri) ri.value = state.refreshInterval || 5;
        $settingsOverlay.classList.add('show'); $body.style.overflow = 'hidden';
    }
    function closeSettings() { $settingsOverlay.classList.remove('show'); $body.style.overflow = ''; document.querySelectorAll('.custom-select.open').forEach(function(cs) { cs.classList.remove('open'); }); }
    function saveSettings() {
        var ri = document.getElementById('settingRefreshInterval'); if (ri) state.refreshInterval = parseInt(ri.value) || 5;
        saveState(); closeSettings(); showToast(t('toastSettingsSaved'), 'success');
        startAutoRefresh();
    }
    function resetSettings() {
        state = { theme:'light', menuLayout:'side', accentColor:'#4f6ef7', sidebarOpen:true, refreshInterval:5, selectedDisk:'' }; saveState();
        currentLang = 'zh-CN'; $html.lang = 'zh-CN';
        applyTheme('light'); state.menuLayout='side'; applyEffectiveLayout('side'); updateLayoutIcons();
        applyAccentColor('#4f6ef7');
        loadLang('zh-CN').then(function() { updateAllI18n(); buildMenus(); setActiveMenu('dashboard'); });
        showToast(t('toastSettingsReset'), 'info');
        startAutoRefresh();
    }

    // ==================== Events ====================
    function bindEvents() {
        $hamburgerBtn.addEventListener('click', toggleSidebar);
        $sidebarOverlay.addEventListener('click', closeMobileSidebar);
        document.getElementById('themeBtn').addEventListener('click', toggleTheme);
        document.getElementById('settingsBtn').addEventListener('click', openSettings);
        document.getElementById('refreshBtn').addEventListener('click', function() {
            refreshCurrentSection();
            showToast(t('toastRefreshing'), 'info', 1.5);
        });
        $settingsOverlay.addEventListener('click', function(e) { if (e.target === $settingsOverlay) closeSettings(); });
        document.getElementById('settingsSave').addEventListener('click', saveSettings);
        document.getElementById('settingsReset').addEventListener('click', resetSettings);
        document.getElementById('settingsClose').addEventListener('click', closeSettings);
        document.getElementById('menuLayoutBtn').addEventListener('click', function() {
            var n = getEffectiveLayout()==='side'?'top':'side'; state.menuLayout = n; saveState();
            applyEffectiveLayout(getEffectiveLayout()); updateLayoutIcons(); buildMenus(); setActiveMenu('dashboard');
            setCustomSelectValue('settingMenuLayout', n); showToast(t('toastMenuLayoutChanged'), 'success', 2.5);
        });
        document.getElementById('btnRefreshDiskInfo').addEventListener('click', refreshDiskInfo);
        document.getElementById('btnRefreshSmart').addEventListener('click', refreshSmart);
        document.getElementById('btnRefreshHib').addEventListener('click', refreshHib);
        document.getElementById('btnSleepNow').addEventListener('click', function() { if(!selectedDisk)return; runCmd(['hdparm','-y',selectedDisk]).then(function(r){if(cmdOk(r)){showToast('hdparm -y: '+t('toastOperationSuccess'),'success');backendDataCache.standbySince[selectedDisk]=Date.now();setTimeout(refreshHib,1000);}else{showToast(t('toastOperationFailed'),'error');}}); });
        document.getElementById('btnWakeUp').addEventListener('click', function() { if(!selectedDisk)return; runCmd(['hdparm','-I',selectedDisk]).then(function(r){if(cmdOk(r)){showToast(t('toastOperationSuccess'),'success');delete backendDataCache.standbySince[selectedDisk];backendDataCache.activeSince[selectedDisk]=Date.now();setTimeout(refreshHib,1000);}else{showToast(t('toastOperationFailed'),'error');}}); });
        document.getElementById('btnSetTimer').addEventListener('click', function() {
            if(!selectedDisk) return;
            var s = document.getElementById('hibTimerSelect');
            if(!s) return;
            runCmd(['hdparm','-S',s.value,selectedDisk]).then(function(r){
                if(cmdOk(r)){
                    showToast('hdparm -S '+s.value+': '+t('toastOperationSuccess'),'success');
                    // 保存设置供后端开机恢复
                    state.hibTimer = s.value;
                    if (!state.hibDisks) state.hibDisks = [];
                    if (state.hibDisks.indexOf(selectedDisk) === -1) state.hibDisks.push(selectedDisk);
                    saveState();
                } else {
                    showToast(t('toastNeedRoot'),'error');
                }
            });
        });
        document.getElementById('btnSetApm').addEventListener('click', function() {
            if(!selectedDisk) return;
            var apmCheck = document.getElementById('hibApmCheck');
            var enabled = apmCheck ? apmCheck.checked : false;
            
            if (!enabled) {
                // 开关关闭，禁用 APM (255)
                runCmd(['hdparm','-B','255',selectedDisk]).then(function(r){
                    if(cmdOk(r)){
                        apmEditing = false;
                        showToast('hdparm -B 255: '+t('toastOperationSuccess'),'success');
                        state.hibApm = 255;
                        if (!state.hibDisks) state.hibDisks = [];
                        if (state.hibDisks.indexOf(selectedDisk) === -1) state.hibDisks.push(selectedDisk);
                        saveState();
                        refreshHib();
                    } else {
                        showToast(t('toastNeedRoot'),'error');
                    }
                });
            } else {
                // 开关打开，启用 APM
                var s = document.getElementById('hibApmInput');
                if(!s) return;
                var val = parseInt(s.value);
                if (isNaN(val) || val < 1 || val > 254) { showToast('APM: 1-254', 'warning'); return; }
                runCmd(['hdparm','-B',String(val),selectedDisk]).then(function(r){
                    if(cmdOk(r)){
                        apmEditing = false;
                        showToast('hdparm -B '+val+': '+t('toastOperationSuccess'),'success');
                        state.hibApm = val;
                        if (!state.hibDisks) state.hibDisks = [];
                        if (state.hibDisks.indexOf(selectedDisk) === -1) state.hibDisks.push(selectedDisk);
                        saveState();
                        refreshHib();
                    } else {
                        showToast(t('toastNeedRoot'),'error');
                    }
                });
            }
        });
        document.getElementById('hibApmCheck').addEventListener('change', function(e) {
            // 开关只控制显示/隐藏输入框，不自动执行
            apmEditing = true;
            var apmInput = document.getElementById('hibApmInput');
            if (apmInput) {
                apmInput.style.display = e.target.checked ? '' : 'none';
            }
        });
        document.getElementById('btnSetCache').addEventListener('click', function() {
            if(!selectedDisk) return;
            var chk = document.getElementById('hibWriteCacheCheck');
            if(!chk) return;
            var val = chk.checked ? '1' : '0'; // checked = 启用写缓存 = -W1
            runCmd(['hdparm','-W',val,selectedDisk]).then(function(r){
                if(cmdOk(r)){
                    cacheEditing = false;
                    showToast('hdparm -W '+val+': '+t('toastOperationSuccess'),'success');
                    refreshHib();
                } else {
                    showToast(t('toastNeedRoot'),'error');
                }
            });
        });
        document.getElementById('hibWriteCacheCheck').addEventListener('change', function() {
            cacheEditing = true;
        });
        document.getElementById('btnShortTest').addEventListener('click', function() { startSelfTest('short'); });
        document.getElementById('btnLongTest').addEventListener('click', function() { startSelfTest('long'); });
        document.getElementById('btnConveyanceTest').addEventListener('click', function() { startSelfTest('conveyance'); });
        document.getElementById('btnAbortTest').addEventListener('click', abortSelfTest);
        // IO 刷新间隔
        var ioSel = document.getElementById('ioRefreshSelect');
        if (ioSel) ioSel.addEventListener('change', function() {
            ioInterval = parseInt(ioSel.value) || 1000;
            state.ioInterval = ioSel.value;
            saveState();
            IoMonitor_restart();
        });
        // IO 详情弹窗
        document.getElementById('ioDetailClose').addEventListener('click', closeIoDetail);
        document.getElementById('ioDetailOverlay').addEventListener('click', function(e) { if (e.target === this) closeIoDetail(); });
        document.getElementById('ioDetailRange').addEventListener('change', function() {
            ioDetailRangeSec = parseInt(this.value) || 60;
            ioDetailRefresh();
        });
        document.querySelectorAll('.color-swatch').forEach(function(el) { el.addEventListener('click', function() { applyAccentColor(el.dataset.color); }); });
        document.getElementById('colorCustomPicker').addEventListener('input', function() { applyAccentColor(this.value); });
        document.getElementById('colorHexInput').addEventListener('input', function() { var v=this.value.trim(); if(!v.startsWith('#'))v='#'+v; if(/^#[0-9a-fA-F]{6}$/.test(v))applyAccentColor(v.toLowerCase()); });
        var $langBtn = document.getElementById('langBtn'), $langDropdown = document.getElementById('langDropdown');
        $langBtn.addEventListener('click', function(e) { e.stopPropagation(); $langDropdown.classList.toggle('show'); });
        $langDropdown.querySelectorAll('.lang-dropdown-item').forEach(function(el) { el.addEventListener('click', function() { onCustomSelectChange('settingLang', el.dataset.lang); $langDropdown.classList.remove('show'); }); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { if ($settingsOverlay.classList.contains('show')) closeSettings(); if (mobileSidebarOpen) closeMobileSidebar(); $langDropdown.classList.remove('show'); }
            if ((e.ctrlKey||e.metaKey) && e.key === '/') { e.preventDefault(); openSettings(); }
            if ((e.ctrlKey||e.metaKey) && e.key === 'b' && getEffectiveLayout()==='side') { e.preventDefault(); toggleSidebar(); }
        });
        var resizeDeb, wasMob = window.innerWidth <= 768;
        window.addEventListener('resize', function() {
            clearTimeout(resizeDeb); var isMob = window.innerWidth <= 768;
            if (isMob !== wasMob) $sidebar.classList.add('resizing');
            resizeDeb = setTimeout(function() {
                if (getEffectiveLayout()!=='side') { wasMob=isMob; $sidebar.classList.remove('resizing'); return; }
                if (!isMob) { closeMobileSidebar(); if (sidebarOpen) $sidebar.classList.remove('collapsed'); }
                else { $sidebar.classList.add('collapsed'); $sidebar.classList.remove('mobile-open'); $sidebarOverlay.classList.remove('show'); mobileSidebarOpen=false; }
                syncSidebarBodyClass(); wasMob=isMob;
                requestAnimationFrame(function() { $sidebar.classList.remove('resizing'); });
            }, 150);
        });
        ['dashboardDiskSelect','diskInfoSelect','smartDiskSelect','hibDiskSelect','selfTestDiskSelect'].forEach(function(id) {
            var sel = document.getElementById(id); if (sel) sel.addEventListener('change', function() {
                selectedDisk=sel.value; state.selectedDisk=selectedDisk; saveState(); setDiskSelectValue(selectedDisk);
                // 切换磁盘时重置编辑状态
                apmEditing = false;
                cacheEditing = false;
                refreshCurrentSection();
            });
        });
    }

    // ==================== Boot ====================
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    // Expose for onclick
    window.App = { t: t, showToast: showToast, toggleSidebar: toggleSidebar, openSettings: openSettings };
})();
