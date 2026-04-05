// State
let userLocation = null;
let userName = '';
let map = null;
let alarmEnabled = true;
let alarmActive = false;
let audioContext = null;
let osc1 = null, osc2 = null, gainNode = null;
let previousLatestQuakeTime = null; // to trigger alarm on new quake

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
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
            
            setTimeout(()=> {
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
        html: `<div class="radar-sweep" style="width:${parseFloat(latest.Magnitude)*15}px; height:${parseFloat(latest.Magnitude)*15}px;"></div>`,
        iconSize: [parseFloat(latest.Magnitude)*15, parseFloat(latest.Magnitude)*15]
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
    if(nUserDisplay) nUserDisplay.style.display = 'flex'; // show in navbar

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
        if(nUserDisplay) nUserDisplay.style.display = 'flex';
        
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
