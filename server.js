const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const JWT = 'reiseappen-secret-2025';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────
const db = new sqlite3.Database('./reiser.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS brukere (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brukernavn TEXT UNIQUE NOT NULL, epost TEXT UNIQUE NOT NULL,
        passord TEXT NOT NULL, fullt_navn TEXT,
        opprettet DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS favoritter (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bruker_id INTEGER NOT NULL,
        fra_navn TEXT, til_navn TEXT, fra_id TEXT, til_id TEXT,
        til_lat REAL, til_lon REAL,
        opprettet DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS historikk (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bruker_id INTEGER NOT NULL,
        fra_navn TEXT, til_navn TEXT, fra_id TEXT, til_id TEXT,
        til_lat REAL, til_lon REAL, fra_lat REAL, fra_lon REAL,
        tidspunkt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrering: legg til nye kolonner hvis de ikke finnes
    const addCol = (tbl, col, def) => {
        db.all(`PRAGMA table_info(${tbl})`, (e, cols) => {
            if (!cols) return;
            if (!cols.find(c => c.name === col)) db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
        });
    };
    addCol('brukere', 'bio', "TEXT DEFAULT ''");
    addCol('brukere', 'avatar_farge', "TEXT DEFAULT '#1c1917'");
    addCol('brukere', 'tema', "TEXT DEFAULT 'light'");
    addCol('brukere', 'gang_fart', "TEXT DEFAULT 'normal'");
    addCol('brukere', 'hjemsted_navn', "TEXT DEFAULT ''");
    addCol('brukere', 'hjemsted_id', "TEXT DEFAULT ''");
    addCol('brukere', 'hjemsted_lat', 'REAL DEFAULT 0');
    addCol('brukere', 'hjemsted_lon', 'REAL DEFAULT 0');
    addCol('brukere', 'jobbsted_navn', "TEXT DEFAULT ''");
    addCol('brukere', 'jobbsted_id', "TEXT DEFAULT ''");
    addCol('brukere', 'jobbsted_lat', 'REAL DEFAULT 0');
    addCol('brukere', 'jobbsted_lon', 'REAL DEFAULT 0');
    addCol('brukere', 'kompakt_ruter', 'INTEGER DEFAULT 0');
    addCol('favoritter', 'notat', "TEXT DEFAULT ''");
    addCol('favoritter', 'stjerner', 'INTEGER DEFAULT 0');
    addCol('favoritter', 'etikett', "TEXT DEFAULT ''");
    addCol('favoritter', 'festet', 'INTEGER DEFAULT 0');
    addCol('favoritter', 'sist_brukt', 'DATETIME DEFAULT NULL');
    addCol('favoritter', 'opprettet', 'DATETIME DEFAULT NULL');
    addCol('favoritter', 'lagret_dato', "TEXT DEFAULT ''");
    addCol('favoritter', 'lagret_tid', "TEXT DEFAULT ''");
    addCol('historikk', 'fra_lat', 'REAL DEFAULT 0');
    addCol('historikk', 'fra_lon', 'REAL DEFAULT 0');
    db.run(`CREATE TABLE IF NOT EXISTS custom_etiketter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bruker_id INTEGER NOT NULL,
        navn TEXT NOT NULL,
        ikon TEXT NOT NULL DEFAULT 'fa-tag',
        farge TEXT NOT NULL DEFAULT '#2563eb',
        opprettet DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: 'Ikke innlogget' });
    try { req.userId = jwt.verify(h.split(' ')[1], JWT).id; next(); }
    catch { res.status(401).json({ error: 'Ugyldig sesjon' }); }
}

// ── AUTH ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    const { brukernavn, epost, passord, fullt_navn } = req.body;
    if (!brukernavn || !epost || !passord) return res.status(400).json({ error: 'Alle felt er påkrevd' });
    if (passord.length < 6) return res.status(400).json({ error: 'Minst 6 tegn' });
    const hash = await bcrypt.hash(passord, 10);
    db.run("INSERT INTO brukere (brukernavn,epost,passord,fullt_navn) VALUES (?,?,?,?)",
        [brukernavn, epost, hash, fullt_navn || brukernavn], function(e) {
            if (e) return res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Brukernavn/e-post finnes allerede' : 'Feil' });
            res.json({ token: jwt.sign({ id: this.lastID }, JWT, { expiresIn: '30d' }),
                bruker: { id: this.lastID, brukernavn, epost, fullt_navn: fullt_navn || brukernavn,
                    bio: '', avatar_farge: '#1c1917', tema: 'light', gang_fart: 'normal' }});
        });
});

app.post('/api/auth/login', (req, res) => {
    const { brukernavn, passord } = req.body;
    if (!brukernavn || !passord) return res.status(400).json({ error: 'Fyll inn alle felt' });
    db.get("SELECT * FROM brukere WHERE brukernavn=? OR epost=?", [brukernavn, brukernavn], async (e, u) => {
        if (!u || !(await bcrypt.compare(passord, u.passord))) return res.status(401).json({ error: 'Feil brukernavn/passord' });
        delete u.passord;
        res.json({ token: jwt.sign({ id: u.id }, JWT, { expiresIn: '30d' }), bruker: u });
    });
});

app.get('/api/auth/me', auth, (req, res) => {
    db.get("SELECT id,brukernavn,epost,fullt_navn,opprettet,bio,avatar_farge,tema,gang_fart,hjemsted_navn,hjemsted_id,hjemsted_lat,hjemsted_lon,jobbsted_navn,jobbsted_id,jobbsted_lat,jobbsted_lon,kompakt_ruter FROM brukere WHERE id=?",
        [req.userId], (e, u) => u ? res.json(u) : res.status(404).json({ error: 'Ikke funnet' }));
});

app.put('/api/auth/profil', auth, (req, res) => {
    const { fullt_navn, epost, bio } = req.body;
    db.run("UPDATE brukere SET fullt_navn=?,epost=?,bio=? WHERE id=?",
        [fullt_navn, epost, bio || '', req.userId], function(e) {
            if (e) return res.status(400).json({ error: e.message.includes('UNIQUE') ? 'E-post i bruk' : 'Feil' });
            res.json({ ok: true });
        });
});

app.put('/api/auth/preferanser', auth, (req, res) => {
    const { avatar_farge, tema, gang_fart } = req.body;
    db.run("UPDATE brukere SET avatar_farge=?,tema=?,gang_fart=? WHERE id=?",
        [avatar_farge || '#1c1917', tema || 'light', gang_fart || 'normal', req.userId],
        () => res.json({ ok: true }));
});

app.put('/api/auth/passord', auth, async (req, res) => {
    const { gammelt, nytt } = req.body;
    if (!gammelt || !nytt || nytt.length < 6) return res.status(400).json({ error: 'Nytt passord: minst 6 tegn' });
    db.get("SELECT passord FROM brukere WHERE id=?", [req.userId], async (e, u) => {
        if (!u || !(await bcrypt.compare(gammelt, u.passord))) return res.status(401).json({ error: 'Feil nåværende passord' });
        db.run("UPDATE brukere SET passord=? WHERE id=?", [await bcrypt.hash(nytt, 10), req.userId], () => res.json({ ok: true }));
    });
});

app.post('/api/auth/slett', auth, async (req, res) => {
    const { passord } = req.body;
    if (!passord) return res.status(400).json({ error: 'Passord kreves' });
    db.get("SELECT passord FROM brukere WHERE id=?", [req.userId], async (e, u) => {
        if (!u || !(await bcrypt.compare(passord, u.passord))) return res.status(401).json({ error: 'Feil passord' });
        db.run("DELETE FROM favoritter WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM historikk WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM brukere WHERE id=?", [req.userId], () => res.json({ ok: true }));
    });
});

app.get('/api/auth/eksport', auth, (req, res) => {
    db.get("SELECT id,brukernavn,epost,fullt_navn,opprettet,bio FROM brukere WHERE id=?", [req.userId], (e, bruker) => {
        db.all("SELECT * FROM favoritter WHERE bruker_id=?", [req.userId], (e1, fav) => {
            db.all("SELECT * FROM historikk WHERE bruker_id=?", [req.userId], (e2, hist) => {
                res.json({ eksportert: new Date().toISOString(), bruker, favoritter: fav || [], historikk: hist || [] });
            });
        });
    });
});

// ── ENTUR GEOCODER ────────────────────────────────────
app.get('/api/steder', async (req, res) => {
    const sok = req.query.sok;
    if (!sok) return res.json([]);
    try {
        const r = await axios.get(`https://api.entur.io/geocoder/v1/autocomplete?text=${encodeURIComponent(sok)}&size=7&lang=no`,
            { headers: { 'ET-Client-Name': 'skoleprosjekt-reiseapp' } });
        res.json(r.data.features.map(f => ({
            navn: f.properties.name, fylke: f.properties.county || '',
            kommune: f.properties.localadmin || f.properties.locality || '',
            kategori: f.properties.layer || '', id: f.properties.id,
            lon: f.geometry?.coordinates?.[0] || null, lat: f.geometry?.coordinates?.[1] || null
        })));
    } catch { res.status(500).json({ error: 'Stedsøk feilet' }); }
});

// ── ENTUR RUTESØK (med walkSpeed og transportFilter) ─────────────────────
app.post('/api/ruter', async (req, res) => {
    const { fra, til, dato, tid, gang_fart, transportFilter } = req.body;
    const walkMap = { slow: 1.0, normal: 1.3, fast: 1.8 };
    const walkSpeed = walkMap[gang_fart] || 1.3;
    let dt = '';
    if (dato && tid) dt = `, dateTime: "${dato}T${tid}:00+02:00"`;

    // Build transport mode filter for GraphQL
    let modeFilter = '';
    if (transportFilter && transportFilter !== 'all') {
        const modeMap = {
            BUS: '[{transportMode: bus},{transportMode: tram},{transportMode: metro}]',
            RAIL: '[{transportMode: rail}]',
            WATER: '[{transportMode: water}]',
            AIR: '[{transportMode: air}]',
        };
        if (modeMap[transportFilter]) {
            modeFilter = `, transportModes: ${modeMap[transportFilter]}`;
        }
    }

    const query = `{
      trip(from:{place:"${fra}"}, to:{place:"${til}"}${dt}, numTripPatterns:8, walkSpeed:${walkSpeed}${modeFilter}) {
        tripPatterns {
          duration walkDistance
          legs {
            mode distance expectedStartTime expectedEndTime aimedStartTime aimedEndTime realtime
            fromPlace { name latitude longitude quay { publicCode description } }
            toPlace { name latitude longitude quay { publicCode description } }
            fromEstimatedCall { destinationDisplay { frontText } }
            intermediateEstimatedCalls { quay { name latitude longitude publicCode } expectedArrivalTime aimedArrivalTime }
            line { publicCode name transportMode authority { name url } }
            pointsOnLink { points }
            situations { summary { value } }
          }
        }
      }
    }`;

    try {
        const r = await axios.post('https://api.entur.io/journey-planner/v3/graphql',
            { query }, { headers: { 'ET-Client-Name': 'skoleprosjekt-reiseapp', 'Content-Type': 'application/json' } });
        res.json(r.data);
    } catch (err) {
        console.error('Entur feil:', err.message);
        res.status(500).json({ error: 'Rutesøk feilet' });
    }
});

// ── KJØRERUTE via OSRM ─────────────────────────────────────────────────────
app.post('/api/kjore', async (req, res) => {
    const { fra_lat, fra_lon, til_lat, til_lon } = req.body;
    if (!fra_lat || !til_lat) return res.status(400).json({ error: 'Koordinater mangler' });
    try {
        const url = `http://router.project-osrm.org/route/v1/driving/${fra_lon},${fra_lat};${til_lon},${til_lat}?overview=full&geometries=polyline&steps=false`;
        const r = await axios.get(url, { timeout: 8000 });
        if (r.data?.routes?.[0]) {
            const route = r.data.routes[0];
            res.json({
                ok: true,
                distanse_m: route.distance,
                varighet_s: route.duration,
                polyline: route.geometry
            });
        } else {
            throw new Error('Ingen rute');
        }
    } catch (e) {
        // Fallback: haversine-estimat
        const R = 6371000;
        const dLat = (til_lat - fra_lat) * Math.PI / 180;
        const dLon = (til_lon - fra_lon) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(fra_lat*Math.PI/180)*Math.cos(til_lat*Math.PI/180)*Math.sin(dLon/2)**2;
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3; // 1.3 vegfaktor
        res.json({ ok: true, fallback: true, distanse_m: dist, varighet_s: dist / (60000/3600) });
    }
});

// ── POI: Wikipedia for aktiviteter + Overpass mirrors for hotell ─

// Wikipedia API — pålitelig, gratis, ingen nøkkel
async function wikipediaNearby(lat, lon, radius = 10000) {
    try {
        const near = await axios.get('https://no.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'geosearch', gsradius: radius,
                gscoord: `${lat}|${lon}`, gslimit: 25, format: 'json' },
            timeout: 8000
        });
        const pages = near.data.query?.geosearch || [];
        if (!pages.length) return [];

        // Hent detaljer (bilde, beskrivelse) - batch
        const ids = pages.map(p => p.pageid).slice(0, 25);
        const det = await axios.get('https://no.wikipedia.org/w/api.php', {
            params: { action: 'query', pageids: ids.join('|'),
                prop: 'pageimages|extracts|info', pithumbsize: 500,
                exintro: true, explaintext: true, exsentences: 3,
                inprop: 'url', format: 'json' },
            timeout: 8000
        });
        const details = det.data.query?.pages || {};

        return pages.map(p => {
            const d = details[p.pageid];
            if (!d || !d.thumbnail) return null; // Uten bilde = sannsynligvis ikke attraksjon

            const title = d.title || '';
            // Filtrer bort gater, veier, personer etc.
            if (/^(Gate|Allé|Veg|Vei|Plass|Stien|Boulevarden)\s/i.test(title)) return null;
            // Filtrer bort personer (heuristikk: navn med fødselsår i extract)
            if (/født \d{4}/i.test(d.extract || '') && !/(kirke|kloster|statue)/i.test(title)) return null;

            const text = ((d.extract || '') + ' ' + title).toLowerCase();
            let kategori = 'Attraksjon', ikon = 'fa-camera';
            if (/museum|utstilling|galleri/.test(text)) { kategori = 'Museum'; ikon = 'fa-landmark'; }
            else if (/kirke|katedral|kapell|kloster/.test(text)) { kategori = 'Kirke'; ikon = 'fa-church'; }
            else if (/slott|borg|festning/.test(text)) { kategori = 'Festning'; ikon = 'fa-chess-rook'; }
            else if (/park|hage|botanisk/.test(text)) { kategori = 'Park'; ikon = 'fa-tree'; }
            else if (/fjell|topp|breen|platået/.test(text)) { kategori = 'Natur'; ikon = 'fa-mountain'; }
            else if (/fjord|elv|innsjø|vann/.test(text)) { kategori = 'Natur'; ikon = 'fa-water'; }
            else if (/monument|statue|minnes/.test(text)) { kategori = 'Monument'; ikon = 'fa-monument'; }
            else if (/teater|opera|konserthus|kinema/.test(text)) { kategori = 'Kultur'; ikon = 'fa-masks-theater'; }
            else if (/stadion|arena|idretts/.test(text)) { kategori = 'Sport'; ikon = 'fa-futbol'; }
            else if (/gård|gods|herregård|våningshus/.test(text)) { kategori = 'Historisk'; ikon = 'fa-scroll'; }
            else if (/fyr|havn|brygge|skipsverft/.test(text)) { kategori = 'Kyst'; ikon = 'fa-anchor'; }
            else if (/tårn|utsikt/.test(text)) { kategori = 'Utsiktspunkt'; ikon = 'fa-mountain-sun'; }

            return {
                id: 'wiki_' + p.pageid, navn: d.title,
                lat: p.lat, lon: p.lon,
                beskrivelse: d.extract || '', bilde: d.thumbnail.source,
                wiki: d.fullurl || `https://no.wikipedia.org/?curid=${p.pageid}`,
                avstand_m: p.dist, kategori, ikon
            };
        }).filter(Boolean);
    } catch (e) {
        console.log('Wiki feil:', e.message);
        return [];
    }
}

// Overpass med multi-mirror fallback
const MIRRORS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
];

async function overpassHotels(lat, lon, radius = 8000) {
    const q = `[out:json][timeout:10];
        (node["tourism"~"^(hotel|hostel|guest_house|apartment)$"]["name"](around:${radius},${lat},${lon});
         way["tourism"~"^(hotel|hostel)$"]["name"](around:${radius},${lat},${lon}););
        out center 30;`;

    for (const mirror of MIRRORS) {
        try {
            const r = await axios.post(mirror, `data=${encodeURIComponent(q)}`,
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 });
            if (r.data?.elements) {
                return r.data.elements.map(el => {
                    const t = el.tags || {};
                    const la = el.lat || el.center?.lat, lo = el.lon || el.center?.lon;
                    if (!la || !lo || !t.name) return null;
                    return {
                        id: 'osm_' + el.id, navn: t.name, lat: la, lon: lo,
                        type: t.tourism || 'hotel',
                        stjerner: t.stars ? parseInt(t.stars) : null,
                        adresse: [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' '),
                        nettside: t.website || t['contact:website'] || '',
                        telefon: t.phone || t['contact:phone'] || '',
                        wifi: t.internet_access === 'wlan' || t.internet_access === 'yes',
                        frokost: t.breakfast === 'yes' || t.breakfast === 'buffet',
                        parkering: t.parking === 'yes',
                        tilgjengelighet: t.wheelchair === 'yes',
                        bilde: `https://picsum.photos/seed/${el.id}/600/400`
                    };
                }).filter(Boolean);
            }
        } catch (e) {
            console.log(`Mirror feil (${mirror.split('/')[2]}), prøver neste`);
        }
    }
    return [];
}

app.post('/api/langs-ruten', async (req, res) => {
    const { punkter } = req.body;
    if (!punkter || !punkter.length) return res.json({ hoteller: [], aktiviteter: [] });

    // Velg opptil 4 nøkkelpunkter
    const n = punkter.length;
    const keyPts = n >= 4
        ? [punkter[0], punkter[Math.floor(n / 3)], punkter[Math.floor(2 * n / 3)], punkter[n - 1]]
        : punkter;

    console.log(`POI-søk langs ${keyPts.length} punkter`);

    const hotellProm = keyPts.map(p => overpassHotels(p[0].toFixed(4), p[1].toFixed(4)));
    const aktivProm = keyPts.map(p => wikipediaNearby(p[0].toFixed(4), p[1].toFixed(4)));

    const [hotellRes, aktivRes] = await Promise.all([
        Promise.allSettled(hotellProm),
        Promise.allSettled(aktivProm)
    ]);

    const allH = [], allA = [];
    hotellRes.forEach(r => { if (r.status === 'fulfilled') allH.push(...r.value); });
    aktivRes.forEach(r => { if (r.status === 'fulfilled') allA.push(...r.value); });

    console.log(`Fant ${allH.length} hoteller, ${allA.length} aktiviteter`);

    // Dedupliser
    const uniqH = [...new Map(allH.map(h => [h.navn.toLowerCase(), h])).values()].slice(0, 20);
    const uniqA = [...new Map(allA.map(a => [a.navn.toLowerCase(), a])).values()]
        .sort((a, b) => a.avstand_m - b.avstand_m)
        .slice(0, 25);

    res.json({ hoteller: uniqH, aktiviteter: uniqA });
});

// Enkelt punkt-søk (fallback)
app.get('/api/poi', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.json({ hoteller: [], aktiviteter: [] });
    const [h, a] = await Promise.all([overpassHotels(lat, lon, 10000), wikipediaNearby(lat, lon, 12000)]);
    res.json({
        hoteller: [...new Map(h.map(x => [x.navn.toLowerCase(), x])).values()].slice(0, 20),
        aktiviteter: [...new Map(a.map(x => [x.navn.toLowerCase(), x])).values()].slice(0, 25)
    });
});

// ── VÆR ──────────────────────────────────────────────
app.get('/api/vaer', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({});
    try {
        const r = await axios.get(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
            { headers: { 'User-Agent': 'skoleprosjekt-reiseapp/2.0' } });
        const d = r.data.properties.timeseries[0]?.data;
        res.json({ temp: d?.instant?.details?.air_temperature, vind: d?.instant?.details?.wind_speed,
            fukt: d?.instant?.details?.relative_humidity,
            symbol: d?.next_1_hours?.summary?.symbol_code || d?.next_6_hours?.summary?.symbol_code });
    } catch { res.status(500).json({}); }
});

// ── FAVORITTER (med notat + stjerner) ────────────────
app.get('/api/favoritter', auth, (req, res) => {
    db.all("SELECT * FROM favoritter WHERE bruker_id=? ORDER BY festet DESC, sist_brukt DESC, opprettet DESC", [req.userId], (e, r) => res.json(r || []));
});
app.post('/api/favoritter', auth, (req, res) => {
    const { fra_navn, til_navn, fra_id, til_id, til_lat, til_lon, notat, etikett, lagret_dato, lagret_tid } = req.body;
    if (!fra_navn || !til_navn) return res.status(400).json({ error: 'Mangler data' });
    db.run("INSERT INTO favoritter (bruker_id,fra_navn,til_navn,fra_id,til_id,til_lat,til_lon,notat,etikett,lagret_dato,lagret_tid) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [req.userId, fra_navn, til_navn, fra_id, til_id, til_lat || 0, til_lon || 0, notat || '', etikett || '', lagret_dato || '', lagret_tid || ''], function(e) {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ ok: true, id: this.lastID });
        });
});
app.put('/api/favoritter/:id', auth, (req, res) => {
    const { notat, etikett, festet, sist_brukt } = req.body;
    if (sist_brukt) {
        db.run("UPDATE favoritter SET sist_brukt=CURRENT_TIMESTAMP WHERE id=? AND bruker_id=?",
            [req.params.id, req.userId], () => res.json({ ok: true }));
    } else if (festet !== undefined && Object.keys(req.body).length === 1) {
        db.run("UPDATE favoritter SET festet=? WHERE id=? AND bruker_id=?",
            [festet ? 1 : 0, req.params.id, req.userId], () => res.json({ ok: true }));
    } else {
        db.run("UPDATE favoritter SET notat=?,etikett=? WHERE id=? AND bruker_id=?",
            [notat || '', etikett || '', req.params.id, req.userId], () => res.json({ ok: true }));
    }
});
app.delete('/api/favoritter/:id', auth, (req, res) => {
    db.run("DELETE FROM favoritter WHERE id=? AND bruker_id=?", [req.params.id, req.userId], () => res.json({ ok: true }));
});

// ── HISTORIKK ────────────────────────────────────────
app.get('/api/historikk', auth, (req, res) => {
    db.all("SELECT * FROM historikk WHERE bruker_id=? ORDER BY tidspunkt DESC LIMIT 10", [req.userId], (e, r) => res.json(r || []));
});
app.post('/api/historikk', auth, (req, res) => {
    const { fra_navn, til_navn, fra_id, til_id, til_lat, til_lon, fra_lat, fra_lon } = req.body;
    db.run("INSERT INTO historikk (bruker_id,fra_navn,til_navn,fra_id,til_id,til_lat,til_lon,fra_lat,fra_lon) VALUES (?,?,?,?,?,?,?,?,?)",
        [req.userId, fra_navn, til_navn, fra_id, til_id, til_lat||0, til_lon||0, fra_lat||0, fra_lon||0], () => res.json({ ok: true }));
});
app.delete('/api/historikk/:id', auth, (req, res) => {
    db.run("DELETE FROM historikk WHERE id=? AND bruker_id=?", [req.params.id, req.userId], () => res.json({ ok: true }));
});
app.delete('/api/historikk', auth, (req, res) => {
    db.run("DELETE FROM historikk WHERE bruker_id=?", [req.userId], () => res.json({ ok: true }));
});

// ── CUSTOM ETIKETTER ─────────────────────────────────
app.get('/api/etiketter', auth, (req, res) => {
    db.all("SELECT * FROM custom_etiketter WHERE bruker_id=? ORDER BY opprettet ASC", [req.userId], (e, r) => res.json(r || []));
});
app.post('/api/etiketter', auth, (req, res) => {
    const { navn, ikon, farge } = req.body;
    if (!navn) return res.status(400).json({ error: 'Navn kreves' });
    db.run("INSERT INTO custom_etiketter (bruker_id,navn,ikon,farge) VALUES (?,?,?,?)",
        [req.userId, navn.slice(0,30), ikon || 'fa-tag', farge || '#2563eb'], function(e) {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ ok: true, id: this.lastID, navn, ikon: ikon||'fa-tag', farge: farge||'#2563eb', bruker_id: req.userId });
        });
});
app.delete('/api/etiketter/:id', auth, (req, res) => {
    db.run("DELETE FROM custom_etiketter WHERE id=? AND bruker_id=?", [req.params.id, req.userId], () => res.json({ ok: true }));
});

// ── HJEMSTED / JOBBSTED ──────────────────────────────
app.get('/api/hjemjobb', auth, (req, res) => {
    db.get("SELECT hjemsted_navn,hjemsted_id,hjemsted_lat,hjemsted_lon,jobbsted_navn,jobbsted_id,jobbsted_lat,jobbsted_lon FROM brukere WHERE id=?",
        [req.userId], (e, r) => res.json(r || {}));
});
app.put('/api/hjemjobb', auth, (req, res) => {
    const { type, navn, id, lat, lon } = req.body;
    if (type === 'hjem') {
        db.run("UPDATE brukere SET hjemsted_navn=?,hjemsted_id=?,hjemsted_lat=?,hjemsted_lon=? WHERE id=?",
            [navn||'', id||'', lat||0, lon||0, req.userId], () => res.json({ ok: true }));
    } else {
        db.run("UPDATE brukere SET jobbsted_navn=?,jobbsted_id=?,jobbsted_lat=?,jobbsted_lon=? WHERE id=?",
            [navn||'', id||'', lat||0, lon||0, req.userId], () => res.json({ ok: true }));
    }
});
app.put('/api/kompakt', auth, (req, res) => {
    const { kompakt } = req.body;
    db.run("UPDATE brukere SET kompakt_ruter=? WHERE id=?", [kompakt?1:0, req.userId], () => res.json({ ok: true }));
});

// ── STATS ────────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
    const u = req.userId;
    db.get("SELECT COUNT(*) as n FROM favoritter WHERE bruker_id=?", [u], (e1, fav) => {
        db.get("SELECT COUNT(*) as n FROM historikk WHERE bruker_id=?", [u], (e2, hist) => {
            db.get("SELECT COUNT(DISTINCT til_navn) as n FROM historikk WHERE bruker_id=?", [u], (e3, dest) => {
                db.get("SELECT til_navn, COUNT(*) as n FROM historikk WHERE bruker_id=? GROUP BY til_navn ORDER BY n DESC LIMIT 1", [u], (e4, top) => {
                    db.all("SELECT DATE(tidspunkt) as dag FROM historikk WHERE bruker_id=? ORDER BY dag DESC", [u], (e5, days) => {
                        // Calculate streak
                        let streak = 0;
                        if (days && days.length) {
                            const unique = [...new Set(days.map(d => d.dag))];
                            const today = new Date().toISOString().split('T')[0];
                            let cur = new Date(today);
                            for (const d of unique) {
                                const diff = Math.round((cur - new Date(d)) / (1000*60*60*24));
                                if (diff === 0 || diff === 1) { streak++; cur = new Date(d); }
                                else break;
                            }
                        }
                        res.json({ favoritter: fav?.n || 0, sok: hist?.n || 0,
                            destinasjoner: dest?.n || 0,
                            favoritt_sted: top?.til_navn || '—',
                            streak });
                    });
                });
            });
        });
    });
});

app.listen(3000, () => console.log('\n  ✅ Server: http://localhost:3000\n'));