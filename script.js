// State
let userLocation = null;
let userName = '';
let map = null;
let alarmEnabled = true;
let alarmActive = false;
let audioContext = null;
let osc1 = null, osc2 = null, gainNode = null;
let previousLatestQuakeTime = null; // to trigger alarm on new quake

// DOM Elements
const onboardingOverlay = document.getElementById('onboarding-overlay');
const btnStart = document.getElementById('btn-start');
const userNameInput = document.getElementById('user-name');
const displayName = document.getElementById('display-name');
const alarmToggle = document.getElementById('alarm-toggle');

const latestQuakeContainer = document.getElementById('latest-quake');
const quakeCountEl = document.getElementById('quake-count');
const userDistanceEl = document.getElementById('user-distance');
const quakeListEl = document.getElementById('quake-list');

const alarmModal = document.getElementById('alarm-modal');
const btnStopAlarm = document.getElementById('btn-stop-alarm');
const alarmDistanceInfo = document.getElementById('alarm-distance-info');

// Constants
const BMKG_AUTO_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json';
const BMKG_TERKINI_URL = 'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json';

// Initialize Map
function initMap() {
    map = L.map('map-container', {
        zoomControl: false // Move zoom control later if needed
    }).setView([-0.789, 113.921], 5); // Center of Indonesia

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
    
    L.control.zoom({ position: 'topright' }).addTo(map);
}

// Distance Calculation (Haversine Formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
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
    } catch (err) {
        console.error("Gagal mengambil data BMKG:", err);
        latestQuakeContainer.innerHTML = `<div class="text-danger"><i class="fas fa-exclamation-triangle"></i> Gagal memuat data.</div>`;
    }
}

// Custom Leaflet Icons
const earthquakeIcon = L.divIcon({
    className: 'custom-quake-marker',
    html: `<div style="background:var(--warning); width:15px; height:15px; border-radius:50%; box-shadow:0 0 10px var(--warning); border:2px solid white;"></div>`,
    iconSize: [20, 20]
});

const latestQuakeIcon = L.divIcon({
    className: 'custom-quake-marker-latest',
    html: `<div style="background:var(--danger); width:20px; height:20px; border-radius:50%; box-shadow:0 0 20px var(--danger); border:3px solid white; animation: pulse-primary 1s infinite;"></div>`,
    iconSize: [26, 26]
});

const userIcon = L.divIcon({
    className: 'user-marker',
    html: `<div style="background:var(--primary); width:18px; height:18px; border-radius:50%; box-shadow:0 0 15px var(--primary); border:3px solid white;"></div>`,
    iconSize: [24, 24]
});

let mapMarkers = [];

function updateDashboard(latest, recentList) {
    // Clear old markers
    mapMarkers.forEach(m => map.removeLayer(m));
    mapMarkers = [];

    // Parse latest coordinates
    const [latLatest, lonLatest] = latest.Coordinates.split(',').map(Number);
    
    // Check for distance if user location is available
    let distanceToUser = null;
    if (userLocation) {
        distanceToUser = calculateDistance(userLocation.lat, userLocation.lon, latLatest, lonLatest);
        userDistanceEl.innerText = `${distanceToUser} km`;
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
        // Click recent item to pan map
        item.addEventListener('click', () => {
            const [qLat, qLon] = q.Coordinates.split(',').map(Number);
            map.flyTo([qLat, qLon], 7);
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

    // Latest Circle (pulse effect via CSS on marker, but let's add a fixed red circle for radius)
    const latestRadius = L.circle([latLatest, lonLatest], {
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.3,
        radius: parseFloat(latest.Magnitude) * 20000
    }).addTo(map);
    mapMarkers.push(latestRadius);

    // Add User Marker
    if (userLocation) {
        const uMarker = L.marker([userLocation.lat, userLocation.lon], { icon: userIcon, zIndexOffset: 2000 })
            .bindPopup(`<b>Lokasi Anda (${userName})</b>`);
        uMarker.addTo(map);
        mapMarkers.push(uMarker);
    }

    // Logic for Early Warning System
    // Check if new latest quake arrived
    if (previousLatestQuakeTime !== latest.DateTime) {
        previousLatestQuakeTime = latest.DateTime;
        
        // Trigger if magnitude >= 5.0 AND distance < 500km, or just showcase purposes we trigger always if distance < 2000km
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
    displayName.innerText = userName;

    // Request Location
    if (navigator.geolocation) {
        btnStart.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mendapatkan Lokasi...`;
        
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    lat: position.coords.latitude,
                    lon: position.coords.longitude
                };
                
                // Hide modal and start app
                onboardingOverlay.classList.remove('active');
                initMap();
                initAudio(); // must init audio on user interaction
                
                // Pan map to user initially
                map.flyTo([userLocation.lat, userLocation.lon], 6);
                
                // Load data
                fetchQuakeData();
                // Polling every 1 minute
                setInterval(fetchQuakeData, 60000);
            },
            (error) => {
                console.error(error);
                alert("Izin lokasi ditolak atau tidak tersedia. Aplikasi tetap berjalan tanpa perhitungan jarak.");
                userLocation = null;
                onboardingOverlay.classList.remove('active');
                initMap();
                initAudio();
                fetchQuakeData();
                setInterval(fetchQuakeData, 60000);
            }
        );
    } else {
        alert("Browser Anda tidak mendukung Geolocation.");
    }
});

// Setup Initial State
window.addEventListener('DOMContentLoaded', () => {
    // Show splash / onboarding
    onboardingOverlay.classList.add('active');
});
