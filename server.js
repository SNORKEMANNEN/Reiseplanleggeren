/* ============================================================================
   REISEPLANLEGGEREN — SERVER (Node.js + Express + SQLite)
   ----------------------------------------------------------------------------
   Denne filen er hele backend-en til appen. Den gjør fire hovedting:

     1) Bruker-håndtering (registrering, innlogging, profil) med JWT-tokens
     2) Lagring av favoritt-ruter, søkehistorikk og brukerens egne steder
     3) "Proxy" mot eksterne API-er (Entur, Wikipedia, Overpass, met.no, OSRM)
        slik at frontend ikke trenger å kjenne nøkler og endepunkter selv
     4) Servering av frontend-filene (index.html) på samme port

   Det viktigste konseptuelle valget her er at alt brukerinnhold ligger lokalt
   i én SQLite-fil (reiser.db) — ingen eksterne databaser. Det er bevisst:
   appen skal kunne kjøres helt frittstående med kun "node server.js".
   ============================================================================ */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bcrypt  = require('bcryptjs');     // hashing av passord — aldri lagre passord i klartekst
const jwt     = require('jsonwebtoken'); // signerte sesjons-tokens
const path    = require('path');

const app = express();

// JWT-hemmeligheten brukes til å signere innloggings-tokens. I en ekte app
// skal denne ligge i en miljøvariabel (process.env.JWT_SECRET), men siden
// dette er et skoleprosjekt holder vi den her av enkelhet.
const JWT = 'reiseappen-secret-2025';

app.use(cors());                              // tillat at frontend kaller api fra andre porter under utvikling
app.use(express.json({ limit: '2mb' }));      // les inn JSON-body fra POST/PUT-requester
app.use(express.static(path.join(__dirname, 'public'))); // server index.html fra ./public


/* ============================================================================
   DATABASE — oppstart og migrering
   ----------------------------------------------------------------------------
   Her lager vi alle tabellene hvis de ikke finnes fra før, og kjører "myke"
   migreringer der vi legger til nye kolonner uten å miste data. Dette gjør at
   man kan oppdatere appen og kjøre den med den eksisterende databasen.
   ============================================================================ */
const db = new sqlite3.Database('./reiser.db');

db.serialize(() => {
    /* ---- Brukere — minimumstabell for autentisering --------------------- */
    db.run(`CREATE TABLE IF NOT EXISTS brukere (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brukernavn TEXT UNIQUE NOT NULL,
        epost      TEXT UNIQUE NOT NULL,
        passord    TEXT NOT NULL,            -- bcrypt-hash, ikke klartekst
        fullt_navn TEXT,
        opprettet  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    /* ---- Favoritter — lagrede reiser med notat/etikett ------------------ */
    db.run(`CREATE TABLE IF NOT EXISTS favoritter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bruker_id INTEGER NOT NULL,
        fra_navn TEXT, til_navn TEXT,
        fra_id   TEXT, til_id   TEXT,        -- Entur-IDer slik at vi kan kalle rute-API igjen
        til_lat REAL, til_lon REAL,
        opprettet DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    /* ---- Historikk — automatisk loggføring av søk ----------------------- */
    db.run(`CREATE TABLE IF NOT EXISTS historikk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bruker_id INTEGER NOT NULL,
        fra_navn TEXT, til_navn TEXT,
        fra_id TEXT,   til_id TEXT,
        til_lat REAL,  til_lon REAL,
        fra_lat REAL,  fra_lon REAL,
        tidspunkt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    /* ---- Migreringshjelper ---------------------------------------------
       Når vi over tid har lagt til nye funksjoner trenger vi nye kolonner.
       Vi sjekker først om kolonnen finnes via "PRAGMA table_info" og legger
       den til hvis ikke. Sånn unngår vi feil hvis databasen finnes fra før.
       ----------------------------------------------------------------- */
    const addCol = (tbl, col, def) => {
        db.all(`PRAGMA table_info(${tbl})`, (e, cols) => {
            if (!cols) return;
            if (!cols.find(c => c.name === col))
                db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
        });
    };

    // Brukerprofil-utvidelser
    addCol('brukere', 'bio',          "TEXT DEFAULT ''");
    addCol('brukere', 'avatar_farge', "TEXT DEFAULT '#2D4A3E'");
    addCol('brukere', 'tema',         "TEXT DEFAULT 'light'");
    addCol('brukere', 'gang_fart',    "TEXT DEFAULT 'normal'");
    addCol('brukere', 'kompakt_ruter','INTEGER DEFAULT 0');

    // Eldre hjem/jobb-kolonner — beholdes for bakoverkompatibilitet, men er
    // erstattet av den nye fleksible "mine_steder"-tabellen lenger ned.
    addCol('brukere', 'hjemsted_navn','TEXT DEFAULT \'\'');
    addCol('brukere', 'hjemsted_id',  'TEXT DEFAULT \'\'');
    addCol('brukere', 'hjemsted_lat', 'REAL DEFAULT 0');
    addCol('brukere', 'hjemsted_lon', 'REAL DEFAULT 0');
    addCol('brukere', 'jobbsted_navn','TEXT DEFAULT \'\'');
    addCol('brukere', 'jobbsted_id',  'TEXT DEFAULT \'\'');
    addCol('brukere', 'jobbsted_lat', 'REAL DEFAULT 0');
    addCol('brukere', 'jobbsted_lon', 'REAL DEFAULT 0');
    addCol('brukere', 'migrert_steder','INTEGER DEFAULT 0'); // for engangs-migrering

    // Favoritt-utvidelser
    addCol('favoritter', 'notat',       "TEXT DEFAULT ''");
    addCol('favoritter', 'stjerner',    'INTEGER DEFAULT 0');
    addCol('favoritter', 'etikett',     "TEXT DEFAULT ''");
    addCol('favoritter', 'festet',      'INTEGER DEFAULT 0');
    addCol('favoritter', 'sist_brukt',  'DATETIME DEFAULT NULL');
    addCol('favoritter', 'opprettet',   'DATETIME DEFAULT NULL');
    addCol('favoritter', 'lagret_dato', "TEXT DEFAULT ''");
    addCol('favoritter', 'lagret_tid',  "TEXT DEFAULT ''");

    // Historikk-utvidelser
    addCol('historikk', 'fra_lat', 'REAL DEFAULT 0');
    addCol('historikk', 'fra_lon', 'REAL DEFAULT 0');

    /* ---- Egendefinerte etiketter for favoritter ------------------------- */
    db.run(`CREATE TABLE IF NOT EXISTS custom_etiketter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bruker_id INTEGER NOT NULL,
        navn  TEXT NOT NULL,
        ikon  TEXT NOT NULL DEFAULT 'fa-tag',
        farge TEXT NOT NULL DEFAULT '#2D4A3E',
        opprettet DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    /* ---- NYTT: Mine steder — fleksibelt sted-system --------------------
       Erstatter de gamle hjemsted/jobbsted-kolonnene. Hver bruker kan nå
       lagre så mange steder de vil, hver med eget navn (f.eks. "Mamma"),
       en kategori (hjem, jobb, skole, …), eget ikon og egen farge.
       Disse vises som hurtigvalg i søket og på profilen.
       ----------------------------------------------------------------- */
    db.run(`CREATE TABLE IF NOT EXISTS mine_steder (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bruker_id  INTEGER NOT NULL,
        navn       TEXT NOT NULL,            -- visningsnavn brukeren skriver, f.eks. "Hjem" eller "Bestemor"
        type       TEXT NOT NULL DEFAULT 'annet', -- kategori: hjem, jobb, skole, familie, trening, hytte, venn, helse, butikk, annet
        sted_navn  TEXT NOT NULL,            -- selve stoppestedet/adressen fra Entur
        sted_id    TEXT NOT NULL,            -- Entur-ID slik at vi kan slå opp ruter
        lat        REAL DEFAULT 0,
        lon        REAL DEFAULT 0,
        ikon       TEXT DEFAULT 'fa-location-dot',
        farge      TEXT DEFAULT '#2D4A3E',
        sortering  INTEGER DEFAULT 0,        -- bestemmer rekkefølge i UI
        opprettet  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});


/* ============================================================================
   AUTENTISERING-MIDDLEWARE
   ----------------------------------------------------------------------------
   Plasseres som andre argument til alle endepunkter som krever innlogging.
   Sjekker JWT-token i Authorization-headeren og legger bruker-id på req.
   ============================================================================ */
function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error: 'Ikke innlogget' });
    try {
        req.userId = jwt.verify(h.split(' ')[1], JWT).id;
        next();
    } catch {
        res.status(401).json({ error: 'Ugyldig sesjon' });
    }
}


/* ============================================================================
   AUTH-ENDEPUNKTER — registrering, innlogging, profil
   ============================================================================ */

// Opprett ny bruker. Krever brukernavn, e-post og passord (min. 6 tegn).
app.post('/api/auth/register', async (req, res) => {
    const { brukernavn, epost, passord, fullt_navn } = req.body;
    if (!brukernavn || !epost || !passord) return res.status(400).json({ error: 'Alle felt er påkrevd' });
    if (passord.length < 6)                 return res.status(400).json({ error: 'Minst 6 tegn' });

    const hash = await bcrypt.hash(passord, 10);
    db.run(
        "INSERT INTO brukere (brukernavn,epost,passord,fullt_navn) VALUES (?,?,?,?)",
        [brukernavn, epost, hash, fullt_navn || brukernavn],
        function(e) {
            if (e) return res.status(400).json({
                error: e.message.includes('UNIQUE') ? 'Brukernavn eller e-post finnes allerede' : 'Feil'
            });
            // Returner et JWT som er gyldig i 30 dager + brukerobjektet
            res.json({
                token: jwt.sign({ id: this.lastID }, JWT, { expiresIn: '30d' }),
                bruker: {
                    id: this.lastID, brukernavn, epost,
                    fullt_navn: fullt_navn || brukernavn,
                    bio: '', avatar_farge: '#2D4A3E', tema: 'light', gang_fart: 'normal'
                }
            });
        }
    );
});

// Logg inn med brukernavn ELLER e-post + passord
app.post('/api/auth/login', (req, res) => {
    const { brukernavn, passord } = req.body;
    if (!brukernavn || !passord) return res.status(400).json({ error: 'Fyll inn alle felt' });

    db.get(
        "SELECT * FROM brukere WHERE brukernavn=? OR epost=?",
        [brukernavn, brukernavn],
        async (e, u) => {
            if (!u || !(await bcrypt.compare(passord, u.passord)))
                return res.status(401).json({ error: 'Feil brukernavn eller passord' });
            delete u.passord; // aldri send hashen tilbake
            res.json({ token: jwt.sign({ id: u.id }, JWT, { expiresIn: '30d' }), bruker: u });
        }
    );
});

// Hent gjeldende bruker basert på token (brukes ved opp-start av frontend)
app.get('/api/auth/me', auth, (req, res) => {
    db.get(
        `SELECT id,brukernavn,epost,fullt_navn,opprettet,bio,avatar_farge,tema,gang_fart,
                hjemsted_navn,hjemsted_id,hjemsted_lat,hjemsted_lon,
                jobbsted_navn,jobbsted_id,jobbsted_lat,jobbsted_lon,
                kompakt_ruter,migrert_steder
         FROM brukere WHERE id=?`,
        [req.userId],
        (e, u) => u ? res.json(u) : res.status(404).json({ error: 'Ikke funnet' })
    );
});

// Oppdater navn, e-post og bio
app.put('/api/auth/profil', auth, (req, res) => {
    const { fullt_navn, epost, bio } = req.body;
    db.run(
        "UPDATE brukere SET fullt_navn=?,epost=?,bio=? WHERE id=?",
        [fullt_navn, epost, bio || '', req.userId],
        function(e) {
            if (e) return res.status(400).json({
                error: e.message.includes('UNIQUE') ? 'E-post er allerede i bruk' : 'Feil'
            });
            res.json({ ok: true });
        }
    );
});

// Oppdater visuelle preferanser (avatar-farge, tema, ganghastighet)
app.put('/api/auth/preferanser', auth, (req, res) => {
    const { avatar_farge, tema, gang_fart } = req.body;
    db.run(
        "UPDATE brukere SET avatar_farge=?,tema=?,gang_fart=? WHERE id=?",
        [avatar_farge || '#2D4A3E', tema || 'light', gang_fart || 'normal', req.userId],
        () => res.json({ ok: true })
    );
});

// Bytt passord — krever det gamle for verifisering
app.put('/api/auth/passord', auth, async (req, res) => {
    const { gammelt, nytt } = req.body;
    if (!gammelt || !nytt || nytt.length < 6) return res.status(400).json({ error: 'Nytt passord: minst 6 tegn' });
    db.get("SELECT passord FROM brukere WHERE id=?", [req.userId], async (e, u) => {
        if (!u || !(await bcrypt.compare(gammelt, u.passord)))
            return res.status(401).json({ error: 'Feil nåværende passord' });
        db.run("UPDATE brukere SET passord=? WHERE id=?",
            [await bcrypt.hash(nytt, 10), req.userId],
            () => res.json({ ok: true }));
    });
});

// Slett konto + alt innhold (favoritter, historikk, mine steder)
app.post('/api/auth/slett', auth, async (req, res) => {
    const { passord } = req.body;
    if (!passord) return res.status(400).json({ error: 'Passord kreves' });
    db.get("SELECT passord FROM brukere WHERE id=?", [req.userId], async (e, u) => {
        if (!u || !(await bcrypt.compare(passord, u.passord)))
            return res.status(401).json({ error: 'Feil passord' });
        db.run("DELETE FROM favoritter      WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM historikk       WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM custom_etiketter WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM mine_steder     WHERE bruker_id=?", [req.userId]);
        db.run("DELETE FROM brukere         WHERE id=?",        [req.userId],
            () => res.json({ ok: true }));
    });
});

// Eksporter alt brukerdata som JSON (GDPR-vennlig)
app.get('/api/auth/eksport', auth, (req, res) => {
    db.get("SELECT id,brukernavn,epost,fullt_navn,opprettet,bio FROM brukere WHERE id=?", [req.userId], (e, bruker) => {
        db.all("SELECT * FROM favoritter   WHERE bruker_id=?", [req.userId], (e1, fav) => {
            db.all("SELECT * FROM historikk  WHERE bruker_id=?", [req.userId], (e2, hist) => {
                db.all("SELECT * FROM mine_steder WHERE bruker_id=?", [req.userId], (e3, steder) => {
                    res.json({
                        eksportert: new Date().toISOString(),
                        bruker, favoritter: fav || [], historikk: hist || [], mine_steder: steder || []
                    });
                });
            });
        });
    });
});


/* ============================================================================
   ENTUR — proxy mot Norges nasjonale reisedata
   ----------------------------------------------------------------------------
   Entur har et åpent autocomplete-API for steder og et GraphQL-endepunkt
   for ruteforslag. Vi proxer disse slik at frontend slipper CORS-trøbbel
   og slipper å vite klient-headeren ('ET-Client-Name') som Entur krever.
   ============================================================================ */

// Stedssøk — brukes når brukeren skriver i fra/til-feltene
app.get('/api/steder', async (req, res) => {
    const sok = req.query.sok;
    if (!sok) return res.json([]);
    try {
        const r = await axios.get(
            `https://api.entur.io/geocoder/v1/autocomplete?text=${encodeURIComponent(sok)}&size=7&lang=no`,
            { headers: { 'ET-Client-Name': 'skoleprosjekt-reiseapp' } }
        );
        // Vi mapper resultatet ned til kun det frontend trenger
        res.json(r.data.features.map(f => ({
            navn:     f.properties.name,
            fylke:    f.properties.county || '',
            kommune:  f.properties.localadmin || f.properties.locality || '',
            kategori: f.properties.layer || '',
            id:       f.properties.id,
            lon:      f.geometry?.coordinates?.[0] || null,
            lat:      f.geometry?.coordinates?.[1] || null
        })));
    } catch {
        res.status(500).json({ error: 'Stedsøk feilet' });
    }
});

// Rutesøk — bygger en GraphQL-spørring mot Entur og returnerer rådata
app.post('/api/ruter', async (req, res) => {
    const { fra, til, dato, tid, gang_fart, transportFilter } = req.body;

    // Ganghastighet i meter per sekund (Entur krever det i denne enheten)
    const walkMap = { slow: 1.0, normal: 1.3, fast: 1.8 };
    const walkSpeed = walkMap[gang_fart] || 1.3;

    // Hvis brukeren har valgt dato+tid, leveres som ISO-streng. Ellers bruker
    // Entur "nå" automatisk.
    let dt = '';
    if (dato && tid) dt = `, dateTime: "${dato}T${tid}:00+02:00"`;

    // Filtrér transportmidler (buss/tog/båt/fly) hvis brukeren har valgt det
    let modeFilter = '';
    if (transportFilter && transportFilter !== 'all') {
        const modeMap = {
            BUS:   '[{transportMode: bus},{transportMode: tram},{transportMode: metro}]',
            RAIL:  '[{transportMode: rail}]',
            WATER: '[{transportMode: water}]',
            AIR:   '[{transportMode: air}]',
        };
        if (modeMap[transportFilter]) modeFilter = `, transportModes: ${modeMap[transportFilter]}`;
    }

    // Selve GraphQL-spørringen — henter de 8 beste forslagene
    const query = `{
      trip(from:{place:"${fra}"}, to:{place:"${til}"}${dt}, numTripPatterns:8, walkSpeed:${walkSpeed}${modeFilter}) {
        tripPatterns {
          duration walkDistance
          legs {
            mode distance expectedStartTime expectedEndTime aimedStartTime aimedEndTime realtime
            fromPlace { name latitude longitude quay { publicCode description } }
            toPlace   { name latitude longitude quay { publicCode description } }
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
        const r = await axios.post(
            'https://api.entur.io/journey-planner/v3/graphql',
            { query },
            { headers: { 'ET-Client-Name': 'skoleprosjekt-reiseapp', 'Content-Type': 'application/json' } }
        );
        res.json(r.data);
    } catch (err) {
        console.error('Entur feil:', err.message);
        res.status(500).json({ error: 'Rutesøk feilet' });
    }
});


/* ============================================================================
   KJØRERUTE via OSRM (åpen kjørerute-tjeneste)
   ----------------------------------------------------------------------------
   Brukes når brukeren velger "Kjøre" som reisemåte. Hvis OSRM er nede,
   faller vi tilbake på en haversine-kalkulasjon (luftlinje + 30% omvei).
   ============================================================================ */
app.post('/api/kjore', async (req, res) => {
    const { fra_lat, fra_lon, til_lat, til_lon } = req.body;
    if (!fra_lat || !til_lat) return res.status(400).json({ error: 'Koordinater mangler' });
    try {
        const url = `http://router.project-osrm.org/route/v1/driving/${fra_lon},${fra_lat};${til_lon},${til_lat}?overview=full&geometries=polyline&steps=false`;
        const r = await axios.get(url, { timeout: 8000 });
        if (r.data?.routes?.[0]) {
            const route = r.data.routes[0];
            res.json({ ok: true, distanse_m: route.distance, varighet_s: route.duration, polyline: route.geometry });
        } else throw new Error('Ingen rute');
    } catch (e) {
        // Fallback: haversine-formelen for store-sirkel-distanse + 30% vegfaktor
        const R = 6371000;
        const dLat = (til_lat - fra_lat) * Math.PI / 180;
        const dLon = (til_lon - fra_lon) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(fra_lat*Math.PI/180)*Math.cos(til_lat*Math.PI/180)*Math.sin(dLon/2)**2;
        const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.3;
        res.json({ ok: true, fallback: true, distanse_m: dist, varighet_s: dist / (60000/3600) });
    }
});


/* ============================================================================
   POI — interessepunkter langs reiseruten
   ----------------------------------------------------------------------------
   Vi henter to typer: hoteller (fra OpenStreetMap via Overpass) og
   attraksjoner (fra norsk Wikipedia via Geosearch). Kombineres slik at
   brukeren ser hva man kan oppleve underveis.
   ============================================================================ */

// Wikipedia: finn artikler nær et koordinat, hent bilde + ingress, og kategoriser
async function wikipediaNearby(lat, lon, radius = 10000) {
    try {
        // Fase 1: hent listen av nærliggende artikler
        const near = await axios.get('https://no.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'geosearch', gsradius: radius,
                gscoord: `${lat}|${lon}`, gslimit: 25, format: 'json' },
            timeout: 8000
        });
        const pages = near.data.query?.geosearch || [];
        if (!pages.length) return [];

        // Fase 2: hent detaljer (tittel, bilde, ingress) for alle samtidig
        const ids = pages.map(p => p.pageid).slice(0, 25);
        const det = await axios.get('https://no.wikipedia.org/w/api.php', {
            params: { action: 'query', pageids: ids.join('|'),
                prop: 'pageimages|extracts|info', pithumbsize: 500,
                exintro: true, explaintext: true, exsentences: 3,
                inprop: 'url', format: 'json' },
            timeout: 8000
        });
        const details = det.data.query?.pages || {};

        // Fase 3: filtrer + kategoriser
        return pages.map(p => {
            const d = details[p.pageid];
            if (!d || !d.thumbnail) return null; // uten bilde regner vi det ikke som attraksjon

            const title = d.title || '';
            // Filtrer ut gateadresser og personartikler
            if (/^(Gate|Allé|Veg|Vei|Plass|Stien|Boulevarden)\s/i.test(title)) return null;
            if (/født \d{4}/i.test(d.extract || '') && !/(kirke|kloster|statue)/i.test(title)) return null;

            // Heuristisk kategorisering basert på tekst i tittel + ingress
            const text = ((d.extract || '') + ' ' + title).toLowerCase();
            let kategori = 'Attraksjon', ikon = 'fa-camera';
            if (/museum|utstilling|galleri/.test(text))                       { kategori='Museum';        ikon='fa-landmark'; }
            else if (/kirke|katedral|kapell|kloster/.test(text))              { kategori='Kirke';         ikon='fa-church'; }
            else if (/slott|borg|festning/.test(text))                        { kategori='Festning';      ikon='fa-chess-rook'; }
            else if (/park|hage|botanisk/.test(text))                         { kategori='Park';          ikon='fa-tree'; }
            else if (/fjell|topp|breen|platået/.test(text))                   { kategori='Natur';         ikon='fa-mountain'; }
            else if (/fjord|elv|innsjø|vann/.test(text))                      { kategori='Natur';         ikon='fa-water'; }
            else if (/monument|statue|minnes/.test(text))                     { kategori='Monument';      ikon='fa-monument'; }
            else if (/teater|opera|konserthus|kinema/.test(text))             { kategori='Kultur';        ikon='fa-masks-theater'; }
            else if (/stadion|arena|idretts/.test(text))                      { kategori='Sport';         ikon='fa-futbol'; }
            else if (/gård|gods|herregård|våningshus/.test(text))             { kategori='Historisk';     ikon='fa-scroll'; }
            else if (/fyr|havn|brygge|skipsverft/.test(text))                 { kategori='Kyst';          ikon='fa-anchor'; }
            else if (/tårn|utsikt/.test(text))                                { kategori='Utsiktspunkt';  ikon='fa-mountain-sun'; }

            return {
                id: 'wiki_' + p.pageid, navn: d.title,
                lat: p.lat, lon: p.lon,
                beskrivelse: d.extract || '',
                bilde: d.thumbnail.source,
                wiki: d.fullurl || `https://no.wikipedia.org/?curid=${p.pageid}`,
                avstand_m: p.dist, kategori, ikon
            };
        }).filter(Boolean);
    } catch (e) { console.log('Wiki feil:', e.message); return []; }
}

// Overpass (OpenStreetMap) gir oss hoteller. Vi prøver flere speil for
// stabilitet — Overpass er ofte tregt eller nede.
const MIRRORS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
];
async function overpassHotels(lat, lon, radius = 8000) {
    const q = `[out:json][timeout:10];
        (node["tourism"~"^(hotel|hostel|guest_house|apartment)$"]["name"](around:${radius},${lat},${lon});
         way ["tourism"~"^(hotel|hostel)$"]["name"](around:${radius},${lat},${lon}););
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
                        type:           t.tourism || 'hotel',
                        stjerner:       t.stars ? parseInt(t.stars) : null,
                        adresse:        [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' '),
                        nettside:       t.website || t['contact:website'] || '',
                        telefon:        t.phone   || t['contact:phone']   || '',
                        wifi:           t.internet_access === 'wlan' || t.internet_access === 'yes',
                        frokost:        t.breakfast === 'yes' || t.breakfast === 'buffet',
                        parkering:      t.parking === 'yes',
                        tilgjengelighet:t.wheelchair === 'yes',
                        bilde: `https://picsum.photos/seed/${el.id}/600/400`
                    };
                }).filter(Boolean);
            }
        } catch (e) { console.log(`Mirror feil (${mirror.split('/')[2]}), prøver neste`); }
    }
    return [];
}

// "Langs ruten" — POI for opptil 4 punkter spredt langs hele reisen
app.post('/api/langs-ruten', async (req, res) => {
    const { punkter } = req.body;
    if (!punkter || !punkter.length) return res.json({ hoteller: [], aktiviteter: [] });

    // Plukk ut start, 1/3, 2/3 og slutt slik at vi dekker hele ruten
    const n = punkter.length;
    const keyPts = n >= 4
        ? [punkter[0], punkter[Math.floor(n / 3)], punkter[Math.floor(2 * n / 3)], punkter[n - 1]]
        : punkter;

    console.log(`POI-søk langs ${keyPts.length} punkter`);

    // Kjør hotell- og attraksjons-søk parallelt for fart
    const hotellProm = keyPts.map(p => overpassHotels(p[0].toFixed(4), p[1].toFixed(4)));
    const aktivProm  = keyPts.map(p => wikipediaNearby(p[0].toFixed(4), p[1].toFixed(4)));
    const [hotellRes, aktivRes] = await Promise.all([
        Promise.allSettled(hotellProm),
        Promise.allSettled(aktivProm)
    ]);

    const allH = [], allA = [];
    hotellRes.forEach(r => { if (r.status === 'fulfilled') allH.push(...r.value); });
    aktivRes .forEach(r => { if (r.status === 'fulfilled') allA.push(...r.value); });

    // Deduplisering basert på navn (samme hotell kan dukke opp flere ganger)
    const uniqH = [...new Map(allH.map(h => [h.navn.toLowerCase(), h])).values()].slice(0, 20);
    const uniqA = [...new Map(allA.map(a => [a.navn.toLowerCase(), a])).values()]
        .sort((a, b) => a.avstand_m - b.avstand_m)
        .slice(0, 25);
    res.json({ hoteller: uniqH, aktiviteter: uniqA });
});

// Enkelt punkt-POI — fallback hvis "langs ruten" ikke fungerer
app.get('/api/poi', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.json({ hoteller: [], aktiviteter: [] });
    const [h, a] = await Promise.all([overpassHotels(lat, lon, 10000), wikipediaNearby(lat, lon, 12000)]);
    res.json({
        hoteller:    [...new Map(h.map(x => [x.navn.toLowerCase(), x])).values()].slice(0, 20),
        aktiviteter: [...new Map(a.map(x => [x.navn.toLowerCase(), x])).values()].slice(0, 25)
    });
});


/* ============================================================================
   VÆR — fra met.no (gratis og fra Meteorologisk institutt)
   ============================================================================ */
app.get('/api/vaer', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({});
    try {
        const r = await axios.get(
            `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
            { headers: { 'User-Agent': 'skoleprosjekt-reiseapp/2.0' } }
        );
        // Hent ut første tidsserie-punkt — det er prognosen for "nå"
        const d = r.data.properties.timeseries[0]?.data;
        res.json({
            temp:   d?.instant?.details?.air_temperature,
            vind:   d?.instant?.details?.wind_speed,
            fukt:   d?.instant?.details?.relative_humidity,
            symbol: d?.next_1_hours?.summary?.symbol_code || d?.next_6_hours?.summary?.symbol_code
        });
    } catch { res.status(500).json({}); }
});


/* ============================================================================
   FAVORITTER — CRUD
   ============================================================================ */
app.get('/api/favoritter', auth, (req, res) => {
    db.all(
        "SELECT * FROM favoritter WHERE bruker_id=? ORDER BY festet DESC, sist_brukt DESC, opprettet DESC",
        [req.userId], (e, r) => res.json(r || [])
    );
});

app.post('/api/favoritter', auth, (req, res) => {
    const { fra_navn, til_navn, fra_id, til_id, til_lat, til_lon, notat, etikett, lagret_dato, lagret_tid } = req.body;
    if (!fra_navn || !til_navn) return res.status(400).json({ error: 'Mangler data' });
    db.run(
        `INSERT INTO favoritter
         (bruker_id,fra_navn,til_navn,fra_id,til_id,til_lat,til_lon,notat,etikett,lagret_dato,lagret_tid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [req.userId, fra_navn, til_navn, fra_id, til_id, til_lat || 0, til_lon || 0,
         notat || '', etikett || '', lagret_dato || '', lagret_tid || ''],
        function(e) {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ ok: true, id: this.lastID });
        }
    );
});

// PUT håndterer tre forskjellige scenarioer på samme endepunkt:
// 1) "sist_brukt: true" → bare oppdater tidsstemplet
// 2) "festet: 0/1" alene → toggle pin
// 3) full redigering → oppdater notat og etikett
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
    db.run("DELETE FROM favoritter WHERE id=? AND bruker_id=?",
        [req.params.id, req.userId], () => res.json({ ok: true }));
});


/* ============================================================================
   HISTORIKK — automatisk loggføring
   ============================================================================ */
app.get('/api/historikk', auth, (req, res) => {
    db.all("SELECT * FROM historikk WHERE bruker_id=? ORDER BY tidspunkt DESC LIMIT 10",
        [req.userId], (e, r) => res.json(r || []));
});
app.post('/api/historikk', auth, (req, res) => {
    const { fra_navn, til_navn, fra_id, til_id, til_lat, til_lon, fra_lat, fra_lon } = req.body;
    db.run(
        `INSERT INTO historikk (bruker_id,fra_navn,til_navn,fra_id,til_id,til_lat,til_lon,fra_lat,fra_lon)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [req.userId, fra_navn, til_navn, fra_id, til_id, til_lat||0, til_lon||0, fra_lat||0, fra_lon||0],
        () => res.json({ ok: true })
    );
});
app.delete('/api/historikk/:id', auth, (req, res) => {
    db.run("DELETE FROM historikk WHERE id=? AND bruker_id=?", [req.params.id, req.userId], () => res.json({ ok: true }));
});
app.delete('/api/historikk', auth, (req, res) => {
    db.run("DELETE FROM historikk WHERE bruker_id=?", [req.userId], () => res.json({ ok: true }));
});


/* ============================================================================
   EGENDEFINERTE ETIKETTER (for favoritter)
   ============================================================================ */
app.get('/api/etiketter', auth, (req, res) => {
    db.all("SELECT * FROM custom_etiketter WHERE bruker_id=? ORDER BY opprettet ASC",
        [req.userId], (e, r) => res.json(r || []));
});
app.post('/api/etiketter', auth, (req, res) => {
    const { navn, ikon, farge } = req.body;
    if (!navn) return res.status(400).json({ error: 'Navn kreves' });
    db.run("INSERT INTO custom_etiketter (bruker_id,navn,ikon,farge) VALUES (?,?,?,?)",
        [req.userId, navn.slice(0,30), ikon || 'fa-tag', farge || '#2D4A3E'],
        function(e) {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ ok: true, id: this.lastID, navn, ikon: ikon||'fa-tag', farge: farge||'#2D4A3E', bruker_id: req.userId });
        });
});
app.delete('/api/etiketter/:id', auth, (req, res) => {
    db.run("DELETE FROM custom_etiketter WHERE id=? AND bruker_id=?",
        [req.params.id, req.userId], () => res.json({ ok: true }));
});


/* ============================================================================
   MINE STEDER — det nye fleksible sted-systemet
   ----------------------------------------------------------------------------
   Erstatter de gamle hjemsted/jobbsted-feltene. Hver bruker kan ha så mange
   steder de vil — hver med egen kategori, ikon og farge. Vises som hurtig-
   knapper i søket og som kort på profilen.
   ============================================================================ */

// Henter alle steder for innlogget bruker. Migrerer automatisk fra de gamle
// hjemsted/jobbsted-kolonnene første gang brukeren bruker det nye systemet.
app.get('/api/mine-steder', auth, (req, res) => {
    db.get("SELECT migrert_steder, hjemsted_navn, hjemsted_id, hjemsted_lat, hjemsted_lon, jobbsted_navn, jobbsted_id, jobbsted_lat, jobbsted_lon FROM brukere WHERE id=?",
        [req.userId], (e, u) => {
            if (e || !u) return res.json([]);

            // Engangs-migrering: hvis brukeren har gamle hjem/jobb-data og
            // ennå ikke er migrert, kopier dem inn i mine_steder-tabellen.
            const trengerMigrering = !u.migrert_steder && (u.hjemsted_navn || u.jobbsted_navn);
            if (trengerMigrering) {
                if (u.hjemsted_navn) {
                    db.run(`INSERT INTO mine_steder (bruker_id,navn,type,sted_navn,sted_id,lat,lon,ikon,farge,sortering)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`,
                        [req.userId, 'Hjem', 'hjem', u.hjemsted_navn, u.hjemsted_id, u.hjemsted_lat, u.hjemsted_lon, 'fa-house', '#2D4A3E', 0]);
                }
                if (u.jobbsted_navn) {
                    db.run(`INSERT INTO mine_steder (bruker_id,navn,type,sted_navn,sted_id,lat,lon,ikon,farge,sortering)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`,
                        [req.userId, 'Jobb', 'jobb', u.jobbsted_navn, u.jobbsted_id, u.jobbsted_lat, u.jobbsted_lon, 'fa-briefcase', '#C4593F', 1]);
                }
                db.run("UPDATE brukere SET migrert_steder=1 WHERE id=?", [req.userId]);
            }

            // Returner alle steder, sortert etter brukerens valgte rekkefølge
            db.all("SELECT * FROM mine_steder WHERE bruker_id=? ORDER BY sortering ASC, opprettet ASC",
                [req.userId], (e2, r) => res.json(r || []));
        });
});

// Opprett nytt sted
app.post('/api/mine-steder', auth, (req, res) => {
    const { navn, type, sted_navn, sted_id, lat, lon, ikon, farge } = req.body;
    if (!navn || !sted_navn || !sted_id)
        return res.status(400).json({ error: 'Mangler navn eller sted' });

    // Plasser nytt sted sist i rekken
    db.get("SELECT MAX(sortering) AS m FROM mine_steder WHERE bruker_id=?", [req.userId], (e, r) => {
        const sort = (r?.m ?? -1) + 1;
        db.run(
            `INSERT INTO mine_steder (bruker_id,navn,type,sted_navn,sted_id,lat,lon,ikon,farge,sortering)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [req.userId, navn.slice(0,40), type || 'annet',
             sted_navn, sted_id, lat || 0, lon || 0,
             ikon || 'fa-location-dot', farge || '#2D4A3E', sort],
            function(e2) {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ ok: true, id: this.lastID });
            }
        );
    });
});

// Oppdater eksisterende sted (navn/type/ikon/farge — eller selve stedet)
app.put('/api/mine-steder/:id', auth, (req, res) => {
    const { navn, type, sted_navn, sted_id, lat, lon, ikon, farge } = req.body;
    db.run(
        `UPDATE mine_steder
         SET navn=?, type=?, sted_navn=?, sted_id=?, lat=?, lon=?, ikon=?, farge=?
         WHERE id=? AND bruker_id=?`,
        [navn, type || 'annet', sted_navn, sted_id,
         lat || 0, lon || 0, ikon || 'fa-location-dot', farge || '#2D4A3E',
         req.params.id, req.userId],
        () => res.json({ ok: true })
    );
});

// Slett sted
app.delete('/api/mine-steder/:id', auth, (req, res) => {
    db.run("DELETE FROM mine_steder WHERE id=? AND bruker_id=?",
        [req.params.id, req.userId], () => res.json({ ok: true }));
});


/* ============================================================================
   ØVRIGE INNSTILLINGER
   ============================================================================ */
// Lagre om brukeren foretrekker kompakt rute-visning
app.put('/api/kompakt', auth, (req, res) => {
    const { kompakt } = req.body;
    db.run("UPDATE brukere SET kompakt_ruter=? WHERE id=?",
        [kompakt ? 1 : 0, req.userId], () => res.json({ ok: true }));
});


/* ============================================================================
   STATISTIKK — for prestasjons-systemet og profil-tall
   ----------------------------------------------------------------------------
   Beregner: antall favoritter, antall søk, antall unike destinasjoner,
   mest besøkte sted og dagens "streak" (antall sammenhengende dager
   brukeren har søkt).
   ============================================================================ */
app.get('/api/stats', auth, (req, res) => {
    const u = req.userId;
    db.get("SELECT COUNT(*) as n FROM favoritter WHERE bruker_id=?", [u], (e1, fav) => {
        db.get("SELECT COUNT(*) as n FROM historikk WHERE bruker_id=?", [u], (e2, hist) => {
            db.get("SELECT COUNT(DISTINCT til_navn) as n FROM historikk WHERE bruker_id=?", [u], (e3, dest) => {
                db.get("SELECT til_navn, COUNT(*) as n FROM historikk WHERE bruker_id=? GROUP BY til_navn ORDER BY n DESC LIMIT 1", [u], (e4, top) => {
                    db.all("SELECT DATE(tidspunkt) as dag FROM historikk WHERE bruker_id=? ORDER BY dag DESC", [u], (e5, days) => {

                        // Streak-beregning: tell sammenhengende dager fra og med i dag
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

                        res.json({
                            favoritter:    fav?.n || 0,
                            sok:           hist?.n || 0,
                            destinasjoner: dest?.n || 0,
                            favoritt_sted: top?.til_navn || '—',
                            streak
                        });
                    });
                });
            });
        });
    });
});


/* ============================================================================
   START SERVER
   ============================================================================ */
app.listen(3000, () => console.log('\n  ✅ Server: http://localhost:3000\n'));