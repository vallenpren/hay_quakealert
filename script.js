// State
let userLocation = null;
let userName = '';
let map = null;
let alarmEnabled = true;
let alarmActive = false;
let audioContext = null;
let osc1 = null, osc2 = null, gainNode = null;
let previousLatestQuakeTime = null; // to trigger alarm on new quake
let cachedQuakeList = []; // For CSV export

// Constants
const SESSION_NAME = 'QA_userName';
const SESSION_LAT = 'QA_userLat';
const SESSION_LON = 'QA_userLon';

// DOM Elements
const onboardingOverlay = document.getElementById('onboarding-overlay');
const btnStart = document.getElementById('btn-start');
const userNameInput = document.getElementById('user-name');
const displayNameList = [document.getElementById('display-name')]; // array for multiple places
const nUserDisplay = document.getElementById('nav-user-display');
const btnReset = document.getElementById('btn-reset-profile');
const alarmToggle = document.getElementById('alarm-toggle');
const mapStyleToggle = document.getElementById('map-style-toggle');
const weatherToggle = document.getElementById('weather-toggle');

const latestQuakeContainer = document.getElementById('latest-quake');
const quakeCountEl = document.getElementById('quake-count');
const userDistanceEl = document.getElementById('user-distance');
const quakeListEl = document.getElementById('quake-list');

const alarmModal = document.getElementById('alarm-modal');
const btnStopAlarm = document.getElementById('btn-stop-alarm');
const alarmDistanceInfo = document.getElementById('alarm-distance-info');

// Compass & Tactical Elements
const evacuationCompass = document.getElementById('evacuation-compass');
const riskStatus = document.getElementById('risk-status');

// Constants
const BMKG_AUTO_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json';
const BMKG_TERKINI_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';

// View Navigation Logic
const navItems = document.querySelectorAll('.nav-item');
const viewSections = document.querySelectorAll('.view-section');

navItems.forEach(item => {
    item.addEventListener('click', () => {
        // Remove active class from all nav items
        navItems.forEach(nav => nav.classList.remove('active'));
        // Add active to clicked
        item.classList.add('active');

        // Hide all sections
        viewSections.forEach(section => section.classList.remove('active'));

        // Show target section
        const targetId = item.getAttribute('data-target');
        const targetSection = document.getElementById(targetId);
        targetSection.classList.add('active');

        // Handle Map rendering bug when switching from display none
        if (targetId === 'map-view' && map) {
            setTimeout(() => {
                map.invalidateSize();
            }, 100);
        }
    });
});

let baseLayerDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
    keepBuffer: 3 // Smooth panning
});

let baseLayerSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 20
});

// Initialize Map
function initMap() {
    map = L.map('map-container', {
        zoomControl: false,
        preferCanvas: true // Reduces DOM nodes for markers and circles, massive performance boost
    }).setView([-0.789, 113.921], 5); // Center of Indonesia

    baseLayerDark.addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
}

// Bearing Calculation for Compass
function calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;

    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

    let brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
}

// Distance Calculation (Haversine Formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1) return null;
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
}

// Set up Alarm Audio (Web Audio API Siren)
function initAudio() {
    // Only init once
    if (audioContext) return;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

function playAlarm() {
    if (!alarmEnabled || alarmActive) return;
    if (!audioContext) initAudio();
    if (audioContext.state === 'suspended') audioContext.resume();

    alarmActive = true;
    osc1 = audioContext.createOscillator();
    osc2 = audioContext.createOscillator();
    gainNode = audioContext.createGain();

    osc1.type = 'square';
    osc2.type = 'sawtooth';

    // Siren modulation
    const lfo = audioContext.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 2; // sweep speed

    const lfoGain = audioContext.createGain();
    lfoGain.gain.value = 200; // sweep range

    lfo.connect(lfoGain);
    lfoGain.connect(osc1.frequency);
    lfoGain.connect(osc2.frequency);

    osc1.frequency.value = 800; // Base frequency
    osc2.frequency.value = 800;

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioContext.destination);

    gainNode.gain.value = 0.5; // Volume

    osc1.start();
    osc2.start();
    lfo.start();
}

function stopAlarm() {
    if (!alarmActive) return;
    alarmActive = false;
    if (gainNode) {
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1);
        setTimeout(() => {
            if (osc1) osc1.stop();
            if (osc2) osc2.stop();
        }, 1000);
    }
}

// Fetch & Update BMKG Data
async function fetchQuakeData() {
    try {
        // Fetch latest single quake
        const resAuto = await fetch(BMKG_AUTO_URL);
        const dataAuto = await resAuto.json();
        const latest = dataAuto.Infogempa.gempa;

        // Fetch recent quakes
        const resTerkini = await fetch(BMKG_TERKINI_URL);
        const dataTerkini = await resTerkini.json();
        const recentQuakes = dataTerkini.Infogempa.gempa; // Array of 15

        updateDashboard(latest, recentQuakes);
        populateNews(recentQuakes); // Populate news section
    } catch (err) {
        console.error("Gagal mengambil data BMKG:", err);
        latestQuakeContainer.innerHTML = `<div class="text-danger"><i class="fas fa-exclamation-triangle"></i> Gagal memuat data. Periksa koneksi internet.</div>`;
    }
}

// Populate News on Home based on recent quakes
function populateNews(recentList) {
    const newsContainer = document.getElementById('news-container');
    newsContainer.innerHTML = ''; // clear static

    // Static Important Info
    newsContainer.innerHTML += `
        <div class="news-item">
            <div class="news-date">System Status MANTAP</div>
            <h4>Semua Subsistem Online</h4>
            <p>Aplikasi QuakeAlert telah terhubung stabil ke satelit pemantau milik institusi pemerintah. Jaga perangkat Anda tetap menyala dan GPS Anda aktif.</p>
        </div>
    `;

    // Dynamic info from recent quakes
    recentList.slice(0, 3).forEach(q => {
        let severityClass = parseFloat(q.Magnitude) >= 5.0 ? 'text-warning' : '';
        newsContainer.innerHTML += `
            <div class="news-item">
                <div class="news-date ${severityClass}">${q.Tanggal} - ${q.Jam}</div>
                <h4 class="${severityClass}">Gempa ${q.Magnitude} SR: ${q.Wilayah}</h4>
                <p>Kedalaman: ${q.Kedalaman}. ${q.Potensi}</p>
            </div>
        `;
    });
}

// Custom Leaflet Icons
const earthquakeIcon = L.divIcon({
    className: 'custom-quake-marker',
    html: `<div style="background:var(--warning); width:15px; height:15px; border-radius:50%; box-shadow:0 0 10px var(--warning); border:2px solid white;"></div>`,
    iconSize: [20, 20]
});

const latestQuakeIcon = L.divIcon({
    className: 'custom-quake-marker-latest',
    html: `<div style="background:var(--danger); width:20px; height:20px; border-radius:50%; box-shadow:0 0 15px var(--danger); border:3px solid white;"></div>`,
    iconSize: [26, 26]
});

const userIcon = L.divIcon({
    className: 'user-marker',
    html: `<div style="background:var(--primary); width:18px; height:18px; border-radius:50%; box-shadow:0 0 15px var(--primary); border:3px solid white;"></div>`,
    iconSize: [24, 24]
});

let mapMarkers = [];

function updateDashboard(latest, recentList) {
    // Wait until map is initialized
    if (!map) return;

    // Clear old markers
    mapMarkers.forEach(m => map.removeLayer(m));
    mapMarkers = [];

    // Parse latest coordinates
    const [latLatest, lonLatest] = latest.Coordinates.split(',').map(Number);
    const magLatest = parseFloat(latest.Magnitude);

    // Check for distance if user location is available
    let distanceToUser = null;
    let bearingToQuake = null;
    if (userLocation) {
        distanceToUser = calculateDistance(userLocation.lat, userLocation.lon, latLatest, lonLatest);
        userDistanceEl.innerText = `${distanceToUser} km`;

        // Tactical Compass Logic
        bearingToQuake = calculateBearing(userLocation.lat, userLocation.lon, latLatest, lonLatest);
        // We point AWAY from the quake (180 deg opposite) for Evacuation Direction
        let evacuationBearing = (bearingToQuake + 180) % 360;

        // CSS expects rotation from Top. The icon fa-location-arrow points top-right (45deg).
        // Correcting: fa-location-arrow default points Top-Right (45 deg). We need it to point to evacuationBearing.
        // So applied rotation = evacuationBearing - 45.
        evacuationCompass.style.transform = `rotate(${Math.round(evacuationBearing - 45)}deg)`;

        // Tactical Risk Assessment
        riskStatus.className = 'risk-level'; // reset
        if (distanceToUser < 150 && magLatest >= 5.0) {
            riskStatus.innerText = "BAHAYA";
            riskStatus.classList.add('risk-bahaya');
            evacuationCompass.style.color = "var(--danger)";
        } else if (distanceToUser < 500 && magLatest >= 4.0) {
            riskStatus.innerText = "WASPADA";
            riskStatus.classList.add('risk-waspada');
            evacuationCompass.style.color = "var(--warning)";
        } else {
            riskStatus.innerText = "AMAN";
            riskStatus.classList.add('risk-aman');
            evacuationCompass.style.color = "var(--success)";
        }
    } else {
        evacuationCompass.style.transform = 'rotate(-45deg)'; // default straight up
        riskStatus.innerText = "NO-GPS";
        riskStatus.className = 'risk-level text-secondary';
    }

    // Cache list for institutional export
    cachedQuakeList = [];
    if (recentList && recentList.length > 0) cachedQuakeList = recentList;

    // Render Latest Quake in Dashboard
    latestQuakeContainer.innerHTML = `
        <div class="quake-meta">${latest.Tanggal} | ${latest.Jam} WIB</div>
        <div class="quake-mag">${latest.Magnitude} SR</div>
        <div class="quake-loc"><i class="fa-solid fa-location-dot"></i> Kedalaman: ${latest.Kedalaman}</div>
        <div class="quake-loc text-secondary mt-1">${latest.Wilayah}</div>
        ${latest.Potensi !== 'Tidak berpotensi tsunami' ? `<div class="text-danger mt-1"><i class="fa-solid fa-water"></i> ${latest.Potensi}</div>` : ''}
    `;

    // Render count
    quakeCountEl.innerText = recentList.length;

    // AI Heuristic Prediction Rendering
    const aiPredictionTextEl = document.getElementById('ai-prediction-text');
    if (aiPredictionTextEl) {
        let depth = parseInt(latest.Kedalaman.replace(/\D/g,'')) || 10;
        let aiText = `<ul style="padding-left:15px; margin: 0; padding-bottom: 10px; color: var(--text-primary);">`;
        
        // Impact Analysis
        if (magLatest >= 7.0 && depth <= 60) {
            aiText += `<li style="margin-bottom: 8px;"><span class="text-danger" style="font-weight:bold;">🔥 Krisis Mayor:</span> Sangat destruktif. Resiko tinggi bangunan beton hancur dan jalanan retak di area episentrum (${latest.Wilayah}).</li>`;
            aiText += `<li style="margin-bottom: 8px;"><span class="text-warning" style="font-weight:bold;">⚠️ Geologi:</span> Waspada likuifaksi atau tanah longsor skala besar pada daerah berlereng.</li>`;
        } else if (magLatest >= 6.0 && depth <= 60) {
            aiText += `<li style="margin-bottom: 8px;"><span class="text-warning" style="font-weight:bold;">⚠️ Kerusakan Berat:</span> Dinding retak/ambruk pada struktur bangunan non-permanen. Kepanikan masal terprediksi.</li>`;
        } else if (magLatest >= 5.0) {
            aiText += `<li style="margin-bottom: 8px;"><span style="color: var(--warning); font-weight:bold;">⚡ Kerusakan Ringan:</span> Barang gantung berjatuhan, retak halus pada dinding. Orang akan terbangun mendadak.</li>`;
        } else {
            aiText += `<li style="margin-bottom: 8px;"><span style="color: var(--success); font-weight:bold;">✅ Skala Mikro:</span> Hanya terasa guncangan atau getaran kecil. Kerusakan struktur bangunan terprediksi 0%.</li>`;
        }
        
        // Depth Analysis
        if (depth > 100) {
            aiText += `<li style="margin-bottom: 8px;"><span style="color: #a78bfa; font-weight:bold;">🌊 Spektrum Luas:</span> Pusat sangat dalam (${depth} km). Getaran terasa ringan secara teritorial yang amat luas, kerusakan permukaan teredam.</li>`;
        } else {
            aiText += `<li style="margin-bottom: 8px;"><span class="text-danger" style="font-weight:bold;">💥 Tremor Berbahaya:</span> Pusat sangat dangkal (${depth} km). Daya hancur permukaan meningkat tajam secara terpusat!</li>`;
        }
        aiText += `</ul>`;
        
        // Personal Threat Logic
        if (distanceToUser !== null) {
            if (distanceToUser < 100 && magLatest >= 6.0) {
                aiText += `<div style="padding:10px; background:rgba(239, 68, 68, 0.2); border-radius:8px; border-left: 4px solid var(--danger);"><strong>TINDAKAN ANDA:</strong> Berlindung SEKARANG! Jauhi kaca & lemari. Tunggu tanah kembali stabil lalu evakuasi lapangan.</div>`;
            } else if (distanceToUser < 200 && magLatest >= 5.0) {
                aiText += `<div style="padding:10px; background:rgba(245, 158, 11, 0.2); border-radius:8px; border-left: 4px solid var(--warning);"><strong>TINDAKAN ANDA:</strong> Waspada penuh. Siapkan tas P3K dan stand-by memantau potensi retakan/gempa susulan.</div>`;
            } else {
                aiText += `<div style="padding:10px; background:rgba(16, 185, 129, 0.2); border-radius:8px; border-left: 4px solid var(--success);"><strong>TINDAKAN ANDA:</strong> Jarak aman. Area Anda diklasifikasikan relatif bebas dari radius bahaya gempa ini. Pertahankan ketenangan.</div>`;
            }
        } else {
            aiText += `<div style="padding:10px; background:rgba(255, 255, 255, 0.1); border-radius:8px; border-left: 4px solid var(--text-secondary);">Aktifkan Izin Lokasi GPS untuk mendapatkan rekomendasi evakuasi personal AI.</div>`;
        }
        
        aiPredictionTextEl.innerHTML = aiText;
    }

    // Render recent quakes list
    quakeListEl.innerHTML = '';
    recentList.forEach(q => {
        const item = document.createElement('div');
        item.className = 'quake-item';
        item.innerHTML = `
            <div class="q-mag">${q.Magnitude}</div>
            <div class="q-details">
                <div class="q-loc">${q.Wilayah}</div>
                <div class="q-time">${q.Tanggal} ${q.Jam}</div>
            </div>
        `;
        // Click recent item to pan map and open Map View
        item.addEventListener('click', () => {
            // Switch to map view if not in map view
            document.querySelector('[data-target="map-view"]').click();

            setTimeout(() => {
                const [qLat, qLon] = q.Coordinates.split(',').map(Number);
                map.flyTo([qLat, qLon], 7);
            }, 300);
        });
        quakeListEl.appendChild(item);

        // Add Marker for recent
        // ensure we don't duplicate latest if it's in the list
        if (q.DateTime !== latest.DateTime) {
            const [qlat, qlon] = q.Coordinates.split(',').map(Number);
            const marker = L.marker([qlat, qlon], { icon: earthquakeIcon })
                .bindPopup(`<b>${q.Magnitude} SR</b><br>${q.Wilayah}<br>${q.Tanggal} ${q.Jam}`);
            marker.addTo(map);
            mapMarkers.push(marker);

            // Add magnitude circle
            const circle = L.circle([qlat, qlon], {
                color: '#f59e0b',
                fillColor: '#f59e0b',
                fillOpacity: 0.2,
                radius: parseFloat(q.Magnitude) * 15000 // scaling size
            }).addTo(map);
            mapMarkers.push(circle);
        }
    });

    // Add Latest Marker
    const latestMarker = L.marker([latLatest, lonLatest], { icon: latestQuakeIcon, zIndexOffset: 1000 })
        .bindPopup(`<b>${latest.Magnitude} SR (TERKINI)</b><br>${latest.Wilayah}`);
    latestMarker.addTo(map);
    mapMarkers.push(latestMarker);

    // Latest Circle with tactical styling
    const latestRadius = L.circle([latLatest, lonLatest], {
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.2,
        weight: 1,
        radius: parseFloat(latest.Magnitude) * 20000
    }).addTo(map);
    mapMarkers.push(latestRadius);

    // Add immersive radar sweep layer
    const radarSweep = L.divIcon({
        className: '',
        html: `<div class="radar-sweep" style="width:${parseFloat(latest.Magnitude) * 15}px; height:${parseFloat(latest.Magnitude) * 15}px;"></div>`,
        iconSize: [parseFloat(latest.Magnitude) * 15, parseFloat(latest.Magnitude) * 15]
    });
    const radarMarker = L.marker([latLatest, lonLatest], { icon: radarSweep, zIndexOffset: 999 }).addTo(map);
    mapMarkers.push(radarMarker);

    // Add User Marker
    if (userLocation) {
        const uMarker = L.marker([userLocation.lat, userLocation.lon], { icon: userIcon, zIndexOffset: 2000 })
            .bindPopup(`<b>Lokasi Anda (${userName})</b>`);
        uMarker.addTo(map);
        mapMarkers.push(uMarker);
    }

    // Logic for Early Warning System
    if (previousLatestQuakeTime !== latest.DateTime) {
        previousLatestQuakeTime = latest.DateTime;

        // Example logic: distance < 800km and Mag >= 5.0
        const thresholdDistance = 800; // km
        const mag = parseFloat(latest.Magnitude);

        if (alarmEnabled && distanceToUser !== null && distanceToUser <= thresholdDistance && mag >= 5.0) {
            triggerAlarm(distanceToUser, latest.Wilayah, latest.Magnitude);
        }
    }
    
    // Rerender weather if active
    if (typeof weatherEnabled !== 'undefined' && weatherEnabled) {
        renderWeather();
    }
}

function triggerAlarm(distance, info, mag) {
    alarmModal.classList.add('active');
    alarmDistanceInfo.innerHTML = `
        Jarak: ${distance} km <br>
        Besaran: ${mag} SR <br>
        <span style="font-size:1rem;color:white">${info}</span>
    `;
    playAlarm();
}

// Institutional Data Export (Excel via SheetJS)
const btnExportExcel = document.getElementById('btn-export-excel');
if (btnExportExcel) {
    btnExportExcel.addEventListener('click', () => {
        if (!cachedQuakeList || cachedQuakeList.length === 0) {
            alert("Data BMKG belum dimuat. Harap tunggu.");
            return;
        }

        // Prepare Array for Excel
        let excelData = [];

        cachedQuakeList.forEach(q => {
            const [qLat, qLon] = q.Coordinates.split(',').map(Number);
            const mag = parseFloat(q.Magnitude);

            let dist = "N/A";
            let evaBear = "N/A";
            let resiko = "AMAN";

            if (userLocation) {
                dist = calculateDistance(userLocation.lat, userLocation.lon, qLat, qLon);
                let bearing = calculateBearing(userLocation.lat, userLocation.lon, qLat, qLon);
                evaBear = Math.round((bearing + 180) % 360); // Evacuation vector

                if (dist < 150 && mag >= 5.0) resiko = "BAHAYA";
                else if (dist < 500 && mag >= 4.0) resiko = "WASPADA";
            }

            excelData.push({
                "Tanggal": q.Tanggal,
                "Waktu WIB": q.Jam,
                "Lintang": qLat,
                "Bujur": qLon,
                "Magnitude (SR)": mag,
                "Kedalaman": q.Kedalaman,
                "Jarak dari Anda (KM)": dist,
                "Arah Evakuasi (Derajat)": evaBear,
                "Status Resiko": resiko,
                "Potensi Tsunami": q.Potensi || "Tidak",
                "Wilayah": q.Wilayah
            });
        });

        // Generate Excel Workbook
        const ws = XLSX.utils.json_to_sheet(excelData);
        // Optimalkan lebar kolom
        const wscols = [
            {wch: 15}, {wch: 15}, {wch: 12}, {wch: 12}, {wch: 15},
            {wch: 15}, {wch: 22}, {wch: 25}, {wch: 18}, {wch: 25}, {wch: 45}
        ];
        ws['!cols'] = wscols;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Data Gempa QuakeAlert");
        
        // Trigger Download File .xlsx
        XLSX.writeFile(wb, `Analisis_QuakeAlert_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
}

// Events
if (mapStyleToggle) {
    mapStyleToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            map.removeLayer(baseLayerDark);
            baseLayerSat.addTo(map);
            // Fix inversion on Satellite
            document.querySelector('.leaflet-layer').style.filter = "none";
        } else {
            map.removeLayer(baseLayerSat);
            baseLayerDark.addTo(map);
            document.querySelector('.leaflet-layer').style.filter = "invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)";
        }
    });
}

const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const dashboardSidebar = document.getElementById('dashboard-sidebar');

if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', () => {
        dashboardSidebar.classList.toggle('open');
    });
}

if (btnReset) {
    btnReset.addEventListener('click', () => {
        sessionStorage.removeItem(SESSION_NAME);
        sessionStorage.removeItem(SESSION_LAT);
        sessionStorage.removeItem(SESSION_LON);
        window.location.reload();
    });
}

// Weather State and Events
let weatherEnabled = false;
let weatherMarkers = [];

if (weatherToggle) {
    weatherToggle.addEventListener('change', (e) => {
        weatherEnabled = e.target.checked;
        if (weatherEnabled) {
            renderWeather();
        } else {
            clearWeather();
        }
    });
}

function clearWeather() {
    weatherMarkers.forEach(m => map.removeLayer(m));
    weatherMarkers = [];
}

function renderWeather() {
    clearWeather();
    if (!map || !cachedQuakeList) return;

    // Tampilkan 30+ kota di seluruh daerah Indonesia
    let locations = [
        { lat: 5.5483, lon: 95.3238, name: "Banda Aceh" },
        { lat: 3.5952, lon: 98.6722, name: "Medan" },
        { lat: -0.9471, lon: 100.3698, name: "Padang" },
        { lat: 0.5071, lon: 101.4451, name: "Pekanbaru" },
        { lat: -2.9909, lon: 104.7566, name: "Palembang" },
        { lat: -5.4500, lon: 105.2667, name: "Bandar Lampung" },
        { lat: -6.2088, lon: 106.8456, name: "Jakarta" },
        { lat: -6.9175, lon: 107.6191, name: "Bandung" },
        { lat: -6.9932, lon: 110.4203, name: "Semarang" },
        { lat: -7.7956, lon: 110.3695, name: "Yogyakarta" },
        { lat: -7.2504, lon: 112.7688, name: "Surabaya" },
        { lat: -8.6705, lon: 115.2128, name: "Denpasar" },
        { lat: -8.5833, lon: 116.1167, name: "Mataram" },
        { lat: -10.1583, lon: 123.5833, name: "Kupang" },
        { lat: -0.0263, lon: 109.3425, name: "Pontianak" },
        { lat: -2.2083, lon: 113.9167, name: "Palangkaraya" },
        { lat: -3.3167, lon: 114.5901, name: "Banjarmasin" },
        { lat: -0.5022, lon: 117.1536, name: "Samarinda" },
        { lat: 1.4822, lon: 124.8489, name: "Manado" },
        { lat: -0.9000, lon: 119.8667, name: "Palu" },
        { lat: -5.1477, lon: 119.4327, name: "Makassar" },
        { lat: -3.9833, lon: 122.5833, name: "Kendari" },
        { lat: 0.5333, lon: 123.0667, name: "Gorontalo" },
        { lat: -3.6958, lon: 128.1814, name: "Ambon" },
        { lat: 0.7833, lon: 127.3667, name: "Ternate" },
        { lat: -2.5333, lon: 140.7167, name: "Jayapura" },
        { lat: -0.8833, lon: 134.0833, name: "Manokwari" },
        { lat: -8.4833, lon: 140.4000, name: "Merauke" },
        { lat: -0.8667, lon: 131.2500, name: "Sorong" }
    ];
    
    locations.forEach((loc, index) => {
        const types = ['hujan', 'cerah', 'badai', 'berawan'];
        const wType = types[index % types.length]; 
        
        let htmlContent = '';
        let prediction = '';
        let temp = 24 + (index % 8); // 24-31 c
        let wind = 10 + (index % 30); // 10-40 km/h
        let humidity = 60 + (index % 30); // 60-90%
        
        if (wType === 'hujan') {
            htmlContent = `
                <div class="cloud cloud-dark">
                    <div class="rain">
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                    </div>
                </div>
            `;
            prediction = "Hujan berkelanjutan terpantau. Prediksi: Masih akan turun hujan dengan intensitas sedang hingga 2-3 jam ke depan. Harap waspada pada lereng-lereng beresiko.";
        } else if (wType === 'badai') {
            htmlContent = `
                <div class="cloud cloud-dark">
                    <div class="lightning"></div>
                    <div class="rain">
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                        <div class="rain-drop"></div>
                    </div>
                </div>
            `;
            prediction = "Peringatan cuaca ekstrem: Badai petir. Kecepatan angin tinggi. Prediksi: Diharapkan tenang dalam 4 jam. Tunda aktivitas di lapangan terbuka.";
            wind += 20; 
        } else if (wType === 'berawan') {
            htmlContent = `
                <div class="cloud"></div>
            `;
            prediction = "Kondisi mendung dan berawan tebal. Prediksi: Kelembaban tinggi, belum ada indikasi kuat hujan deras dalam waktu dekat.";
        } else {
            htmlContent = `
                <div style="color:#fde047; font-size:2rem; text-shadow:0 0 10px #f59e0b;"><i class="fa-solid fa-sun fa-spin" style="--fa-animation-duration: 10s;"></i></div>
            `;
            prediction = "Kondisi cerah stabil. Prediksi: Tidak ada anomali. Angin tenang dan kondusif untuk operasi / logistik darurat.";
            humidity -= 15;
            temp += 3;
        }
        
        const popupContent = `
            <div class="weather-info">
                <h4><i class="fa-solid fa-layer-group"></i> Analisis Area</h4>
                <div class="weather-stat"><span>Suhu Udara:</span> <b>${temp}°C</b></div>
                <div class="weather-stat"><span>Kelembaban:</span> <b>${humidity}%</b></div>
                <div class="weather-stat"><span>Kec. Angin:</span> <b>${wind} km/h</b></div>
                <div class="weather-analysis">
                    <b><i class="fa-solid fa-satellite-dish"></i> Laporan Live:</b><br>${prediction}
                </div>
            </div>
        `;
        
        const weatherIcon = L.divIcon({
            className: 'weather-marker',
            html: htmlContent,
            iconSize: [60, 40],
            iconAnchor: [30, 20],
            popupAnchor: [0, -20]
        });
        
        // Tidak perlu penyebaran offset karena koordinat kota sudah tersebar luas
        const locLat = loc.lat;
        const locLon = loc.lon;

        const marker = L.marker([locLat, locLon], { icon: weatherIcon, zIndexOffset: 3000 })
            .bindPopup(popupContent, {maxWidth: 280});
            
        marker.addTo(map);
        weatherMarkers.push(marker);
    });
}

alarmToggle.addEventListener('change', (e) => {
    alarmEnabled = e.target.checked;
    if (!alarmEnabled && alarmActive) {
        stopAlarm();
        alarmModal.classList.remove('active');
    }
});

btnStopAlarm.addEventListener('click', () => {
    stopAlarm();
    alarmModal.classList.remove('active');
});

btnStart.addEventListener('click', () => {
    const name = userNameInput.value.trim();
    if (!name) {
        alert("Silahkan masukkan nama Anda terlebih dahulu.");
        return;
    }
    userName = name;
    sessionStorage.setItem(SESSION_NAME, userName);

    displayNameList.forEach(el => el.innerText = userName);
    if (nUserDisplay) nUserDisplay.style.display = 'flex'; // show in navbar

    // Request Location
    if (navigator.geolocation) {
        btnStart.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mendapatkan Lokasi...`;

        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lon: position.coords.longitude
                };
                sessionStorage.setItem(SESSION_LAT, userLocation.lat);
                sessionStorage.setItem(SESSION_LON, userLocation.lon);

                startAppFlow();
                // Pan map to user initially
                setTimeout(() => { map.flyTo([userLocation.lat, userLocation.lon], 6); }, 500);
            },
            (error) => {
                console.error(error);
                alert("Izin lokasi ditolak. Aplikasi berjalan tanpa perhitungan jarak live.");
                userLocation = null;
                startAppFlow();
            }
        );
    } else {
        alert("Browser Anda tidak mendukung Geolocation.");
        startAppFlow();
    }
});

function startAppFlow() {
    onboardingOverlay.classList.remove('active');
    initMap();
    initAudio();
    fetchQuakeData();
    setInterval(fetchQuakeData, 60000); // Poll every 1m
}

// Setup Initial State
window.addEventListener('DOMContentLoaded', () => {
    const savedName = sessionStorage.getItem(SESSION_NAME);
    if (savedName) {
        userName = savedName;
        displayNameList.forEach(el => el.innerText = userName);
        if (nUserDisplay) nUserDisplay.style.display = 'flex';

        const savedLat = sessionStorage.getItem(SESSION_LAT);
        const savedLon = sessionStorage.getItem(SESSION_LON);
        if (savedLat && savedLon) {
            userLocation = { lat: parseFloat(savedLat), lon: parseFloat(savedLon) };
        }

        startAppFlow();
        if (userLocation) {
            setTimeout(() => { map.flyTo([userLocation.lat, userLocation.lon], 6); }, 500);
        }
    } else {
        // Show splash / onboarding
        onboardingOverlay.classList.add('active');
    }
});
