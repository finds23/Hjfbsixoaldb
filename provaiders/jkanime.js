/**
 * JKAnime (jkanime.net) - plugin para Nuvio
 * Flujo: TMDB -> AniList (romaji/temporada) -> buscar en JKAnime -> pagina del episodio
 *        -> var servers (base64) -> extractor por servidor.
 */
var JK_BASE = "https://jkanime.net";
var TMDB_API_KEY = "56db0ec297530920213e1503706b81ff";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Activa/desactiva fuentes. Solo Streamtape esta probado.
var ENABLED_SOURCES = {
  Streamtape: true,
  Streamwish: false, // pendiente: falta el hash del script del embed
  Voe: false         // no reproducia en el episodio de prueba
};

// ---------- utilidades ----------
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function b64decode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (s.length % 4) s += "=";
  if (typeof atob === "function") {
    var bin = atob(s);
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var out = "", buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === "=") break;
    var v = chars.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  return out;
}

async function fetchText(url, headers) {
  var resp = await fetch(url, { headers: Object.assign({ "User-Agent": UA }, headers || {}) });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " en " + url);
  return resp.text();
}

// ---------- TMDB / AniList ----------
var ASIAN_COUNTRIES = ["JP", "CN", "KR", "TW", "HK"];

async function getTMDBInfo(tmdbId, type) {
  var path = type === "movie" ? "movie" : "tv";
  var url = "https://api.themoviedb.org/3/" + path + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&language=en-US";
  var data = await fetch(url, { headers: { "User-Agent": UA } }).then(function (r) { return r.json(); });
  if (!data || data.success === false) return null;
  var title = data.title || data.name || data.original_title || data.original_name;
  if (!title) return null;
  var countries = type === "movie"
    ? (data.production_countries || []).map(function (c) { return c.iso_3166_1; })
    : (data.origin_country || []);
  var isAnimation = (data.genres || []).some(function (g) { return g.id === 16; });
  return { title: title, originCountries: countries, isAnimation: isAnimation };
}

function looksLikeAnime(info) {
  var asian = info.originCountries.some(function (c) { return ASIAN_COUNTRIES.indexOf(c) !== -1; });
  return asian && info.isAnimation;
}

var SEASON_SUFFIX_RE = /\s+(?:\d+(?:st|nd|rd|th)\s+season|season\s+\d+(?:\s+part\s+\d+)?|part\s+\d+)\s*$/i;

// Devuelve { baseRomaji, targetRomaji } usando AniList (titulo romaji = el que usa JKAnime)
async function getAniListInfo(title, seasonNum) {
  try {
    var query = "query ($search: String) { Page(page: 1, perPage: 15) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { title { romaji } seasonYear startDate { year month day } } } }";
    var resp = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: query, variables: { search: title } })
    });
    if (!resp.ok) return null;
    var json = await resp.json();
    var results = json && json.data && json.data.Page && json.data.Page.media;
    if (!Array.isArray(results) || results.length === 0) return null;
    var baseRomaji = (results[0].title.romaji || "").replace(SEASON_SUFFIX_RE, "").trim();
    if (!baseRomaji) return null;
    var same = results.filter(function (m) {
      return (m.title.romaji || "").replace(SEASON_SUFFIX_RE, "").trim().toLowerCase() === baseRomaji.toLowerCase();
    }).map(function (m) {
      var sd = m.startDate || {};
      return { title: m.title.romaji, key: (sd.year || m.seasonYear || 0) * 10000 + (sd.month || 1) * 100 + (sd.day || 1) };
    }).sort(function (a, b) { return a.key - b.key; });
    var target = same[seasonNum - 1];
    return { baseRomaji: baseRomaji, targetRomaji: target ? target.title : null };
  } catch (e) {
    console.warn("[JKAnime] AniList fallo: " + e.message);
    return null;
  }
}

// ---------- busqueda en JKAnime ----------
var NON_ANIME_PATHS = ["buscar", "directorio", "horario", "comunidad", "usuario", "genero", "studio", "idioma", "dash", "ajax", "jkplayer", "estrenos", "top", "pedidos", "historial", "guardado", "notificaciones", "aplicacion", "salir"];

async function searchJK(query) {
  var html = await fetchText(JK_BASE + "/buscar/" + encodeURIComponent(query), { "Referer": JK_BASE + "/" });
  var re = /<h5[^>]*>\s*<a[^>]+href="(?:https?:\/\/jkanime\.net)?\/([^"\/?#]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
  var found = [], seen = {}, m;
  var matches = [];
  while ((m = re.exec(html)) !== null) matches.push({ slug: m[1], title: m[2], index: m.index });
  if (matches.length === 0) {
    // respaldo: cualquier enlace <a href=".../slug/">Titulo</a>
    var re2 = /<a[^>]+href="(?:https?:\/\/jkanime\.net)?\/([a-z0-9\-]+)\/?"[^>]*>([^<]{3,})<\/a>/gi;
    while ((m = re2.exec(html)) !== null) {
      if (NON_ANIME_PATHS.indexOf(m[1]) === -1) matches.push({ slug: m[1], title: m[2], index: m.index });
    }
  }
  matches.forEach(function (it, i) {
    if (seen[it.slug]) return;
    seen[it.slug] = true;
    var title = it.title.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
    // el tipo (Serie/Pelicula/OVA/Especial) aparece antes del titulo, dentro del mismo bloque
    var prevEnd = i > 0 ? matches[i - 1].index : 0;
    var block = html.substring(Math.max(prevEnd, it.index - 600), it.index);
    var t = /(Pelicula|Película|Movie|OVA|ONA|Especial|Serie)/gi, tm, kind = "";
    while ((tm = t.exec(block)) !== null) kind = tm[1];
    found.push({ slug: it.slug, title: title, kind: norm(kind) });
  });
  return found;
}

function seasonOf(title) {
  var m;
  if ((m = /(\d+)(?:st|nd|rd|th)\s+season/i.exec(title))) return parseInt(m[1], 10);
  if ((m = /season\s+(\d+)/i.exec(title))) return parseInt(m[1], 10);
  var roman = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9 };
  if ((m = /\s(II|III|IV|V|VI|VII|VIII|IX)(?=:|\s+part\s+\d+\s*$|\s*$)/.exec(title))) return roman[m[1]];
  if ((m = /\s([2-9])\s*$/.exec(title))) return parseInt(m[1], 10);
  return 1;
}

function pickBestMatch(candidates, target, seasonNum, type) {
  var pool = candidates;
  var wantKind = type === "movie" ? ["pelicula", "movie"] : ["serie"];
  var byKind = pool.filter(function (c) { return wantKind.indexOf(c.kind) !== -1; });
  if (byKind.length) pool = byKind;
  if (type !== "movie") {
    var bySeason = pool.filter(function (c) { return seasonOf(c.title) === seasonNum; });
    if (bySeason.length) pool = bySeason;
  }
  var t = norm(target);
  var best = pool.find(function (c) { return norm(c.title) === t; });
  if (best) return best;
  best = pool.find(function (c) { return norm(c.title).indexOf(t) !== -1 || t.indexOf(norm(c.title)) !== -1; });
  return best || pool[0];
}

// ---------- servidores del episodio ----------
async function getEpisodeServers(slug, epNumber) {
  var url = JK_BASE + "/" + slug + "/" + epNumber + "/";
  var html = await fetchText(url, { "Referer": JK_BASE + "/" + slug + "/" });
  var m = /var\s+servers\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (!m) return [];
  var list;
  try { list = JSON.parse(m[1]); } catch (e) { return []; }
  var out = [];
  list.forEach(function (s) {
    if (!s || !s.remote || !s.server) return;
    try {
      var embed = b64decode(s.remote).trim();
      if (/^https?:\/\//i.test(embed) || /^\/\//.test(embed)) {
        out.push({ name: String(s.server), url: embed.indexOf("//") === 0 ? "https:" + embed : embed });
      }
    } catch (e) { /* servidor ignorado */ }
  });
  return out;
}

// ---------- extractores ----------
function extractStreamtapeFromHtml(html) {
  var re = /getElementById\('(?:robotlink|botlink)'\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*(?:''\s*\+\s*)?\(\s*['"]([^'"]*)['"]\s*\)((?:\.substring\(\d+\))*)/g;
  var m, last = null;
  while ((m = re.exec(html)) !== null) last = m; // 'ideoolink' son senuelos; robotlink/botlink dan el enlace valido
  if (!last) return null;
  var tail = last[2];
  var subs = last[3].match(/\.substring\(\d+\)/g) || [];
  subs.forEach(function (s) { tail = tail.substring(parseInt(/\d+/.exec(s)[0], 10)); });
  var url = last[1] + tail;
  if (url.indexOf("//") === 0) url = "https:" + url;
  return url + "&stream=1";
}

async function extractStreamtape(embedUrl) {
  var html = await fetchText(embedUrl, { "Referer": JK_BASE + "/" });
  var url = extractStreamtapeFromHtml(html);
  if (!url) throw new Error("No se encontro el enlace en el embed de Streamtape");
  return { url: url, headers: { "Referer": "https://streamtape.com/", "User-Agent": UA } };
}

async function extractStreamwish(embedUrl) {
  throw new Error("Streamwish aun no implementado");
}

async function extractVoe(embedUrl) {
  throw new Error("Voe aun no implementado");
}

var ALL_SOURCES = {
  Streamtape: { label: "Streamtape", extract: extractStreamtape },
  Streamwish: { label: "Streamwish", extract: extractStreamwish },
  Voe: { label: "Voe", extract: extractVoe }
};
var SOURCE_EXTRACTORS = {};
Object.keys(ALL_SOURCES).forEach(function (k) { if (ENABLED_SOURCES[k]) SOURCE_EXTRACTORS[k] = ALL_SOURCES[k]; });

function findSourceKey(serverName) {
  var n = norm(serverName);
  return Object.keys(SOURCE_EXTRACTORS).find(function (k) { return n.indexOf(k.toLowerCase()) !== -1; });
}

// ---------- punto de entrada ----------
async function getStreams(tmdbId, type, season, episode) {
  if (!tmdbId || !type) return [];
  try {
    var seasonNum = type === "movie" ? 1 : (season ? Number(season) : 1);
    var info = await getTMDBInfo(tmdbId, type);
    if (!info) return [];
    if (!looksLikeAnime(info)) {
      console.log("[JKAnime] Descartado (no parece anime): " + info.title);
      return [];
    }

    var ani = await getAniListInfo(info.title, seasonNum);
    var base = (ani && ani.baseRomaji) || info.title;
    var target = (ani && ani.targetRomaji) || (seasonNum !== 1 ? base + " " + seasonNum : base);
    console.log("[JKAnime] buscar=\"" + base + "\" objetivo=\"" + target + "\" temporada=" + seasonNum);

    var candidates = await searchJK(base);
    if (candidates.length === 0 && base !== info.title) candidates = await searchJK(info.title);
    if (candidates.length === 0) return [];

    var match = pickBestMatch(candidates, target, seasonNum, type);
    if (!match) return [];
    console.log("[JKAnime] Match: \"" + match.title + "\" (" + match.slug + ")");

    var epNumber = type === "movie" ? 1 : (episode !== undefined ? Number(episode) : 1);
    var servers = await getEpisodeServers(match.slug, epNumber);
    if (servers.length === 0) return [];

    var jobs = servers.map(async function (server) {
      var key = findSourceKey(server.name);
      if (!key) return null;
      var source = SOURCE_EXTRACTORS[key];
      try {
        var resolved = await source.extract(server.url);
        var list = Array.isArray(resolved) ? resolved : [resolved];
        return list.map(function (v) {
          var o = {
            name: "JKAnime",
            title: "",
            url: v.url,
            quality: "\uD83D\uDCFA " + source.label + "\n1080p | WEB-DL | Anime\n\uD83C\uDDEF\uD83C\uDDF5 JAPON\u00C9S \u00B7 \uD83C\uDDF2\uD83C\uDDFD Sub",
            headers: v.headers
          };
          if (v.type) o.type = v.type;
          return o;
        });
      } catch (e) {
        console.warn("[" + source.label + "] fallo: " + e.message);
        return null;
      }
    });
    var results = await Promise.all(jobs);
    var final = [].concat.apply([], results.filter(Boolean));
    console.log("[JKAnime] " + final.length + " streams");
    return final;
  } catch (e) {
    console.error("[JKAnime] Error: " + e.message);
    return [];
  }
}

exports.getStreams = getStreams;
