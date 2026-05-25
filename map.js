/* ── NYC Water Tank Map ── */

var BASE    = 'https://data.cityofnewyork.us/resource/rytv-g5ui.json';
var GEO_URL = 'https://data.cityofnewyork.us/resource/7t3b-ywvw.geojson';

/*
  Instead of fetching 100k raw rows, we hit the Socrata aggregation API.
  Query 1: one row per building — total inspection count.
  Query 2: one row per building — violation count only.
  Both are tiny payloads (~5–15k buildings); we merge them client-side.
*/
var TOTALS_URL = BASE
  + '?$select=bin,borough,latitude,longitude,count(*)%20as%20total'
  + '&$group=bin,borough,latitude,longitude'
  + '&$where=latitude%20IS%20NOT%20NULL'
  + '&$limit=50000';

var VIOLS_URL = BASE
  + '?$select=bin,count(*)%20as%20violations'
  + '&$group=bin'
  + '&$where=violation_code%20IS%20NOT%20NULL'
  + '&$limit=50000';

/* ── State ── */
var tanks  = [];
var geo    = null;
var activeB = 'All';
var mode   = 'dot';

/* ── SVG handles ── */
var svg, g, proj, pathGen, zoomBehavior;
var W = 1060, H = 540;

/* ── Global error display ── */
window.onerror = function (msg, src, line, col, err) {
  showErr('JS error (line ' + line + '): ' + msg + (err ? '\n' + err.stack : ''));
  return false;
};

function showErr(msg) {
  var box = document.getElementById('err-box');
  box.textContent = msg;
  box.style.display = 'block';
  var ld = document.getElementById('loading');
  if (ld) ld.style.display = 'none';
}

function setLoadingText(msg) {
  var el = document.getElementById('loading-detail');
  if (el) el.textContent = msg;
}

/* ── Borough name normalizer ── */
function nb(s) {
  if (!s) return 'Unknown';
  var l = s.trim().toLowerCase();
  if (l.indexOf('manhattan') !== -1) return 'Manhattan';
  if (l.indexOf('brooklyn')  !== -1) return 'Brooklyn';
  if (l.indexOf('queens')    !== -1) return 'Queens';
  if (l.indexOf('bronx')     !== -1) return 'Bronx';
  if (l.indexOf('staten')    !== -1) return 'Staten Island';
  return s.trim();
}

function gbn(f) {
  var p = f.properties;
  return nb(p.boro_name || p.BoroName || p.boroname || p.NAME || p.name || '');
}

/* ── Data loading ── */
function init() {
  setLoadingText('Fetching borough boundaries…');

  Promise.all([
    fetch(GEO_URL)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),

    fetch(TOTALS_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('Totals query failed: HTTP ' + r.status);
        setLoadingText('Fetching violation counts…');
        return r.json();
      }),

    fetch(VIOLS_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('Violations query failed: HTTP ' + r.status);
        return r.json();
      })
  ])
  .then(function (results) {
    geo = results[0];
    var totalData = results[1];
    var vioData   = results[2];

    if (!Array.isArray(totalData)) {
      throw new Error('Unexpected response from totals query:\n' + JSON.stringify(totalData).slice(0, 300));
    }

    setLoadingText('Building map…');

    /* Build violation lookup: bin → count */
    var vioMap = {};
    vioData.forEach(function (d) {
      vioMap[d.bin] = parseInt(d.violations, 10) || 0;
    });

    /* Build one record per building */
    tanks = totalData
      .filter(function (d) { return d.latitude && d.longitude; })
      .map(function (d) {
        return {
          bin:     d.bin,
          borough: nb(d.borough),
          lat:     parseFloat(d.latitude),
          lon:     parseFloat(d.longitude),
          tot:     parseInt(d.total, 10) || 0,
          vio:     vioMap[d.bin] || 0
        };
      });

    if (tanks.length === 0) {
      throw new Error('No buildings with coordinates returned. The $where clause may need adjusting.');
    }

    document.getElementById('loading').style.display = 'none';
    setupMap();
    update();
  })
  .catch(function (e) {
    document.getElementById('loading').style.display = 'none';
    showErr('Failed to load data:\n' + e.message);
  });
}

/* ── SVG setup ── */
function setupMap() {
  svg = d3.select('#map')
    .attr('viewBox', '0 0 ' + W + ' ' + H)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  proj = geo
    ? d3.geoMercator().fitSize([W, H], geo)
    : d3.geoMercator().center([-73.97, 40.71]).scale(105000).translate([W / 2, H / 2]);

  pathGen = d3.geoPath().projection(proj);

  zoomBehavior = d3.zoom()
    .scaleExtent([1, 16])
    .on('zoom', function (e) { g.attr('transform', e.transform); });
  svg.call(zoomBehavior);

  g = svg.append('g');
  g.append('g').attr('id', 'geo-layer');
  g.append('g').attr('id', 'dot-layer');

  if (geo) {
    d3.select('#geo-layer').selectAll('path')
      .data(geo.features)
      .join('path')
      .attr('d', pathGen)
      .attr('cursor', 'pointer')
      .on('click',      function (e, d) { setBorough(gbn(d)); })
      .on('mouseenter', function (e, d) {
        var b    = gbn(d);
        var rows = tanks.filter(function (t) { return t.borough === b; });
        var tot  = rows.reduce(function (s, t) { return s + t.tot; }, 0);
        var vio  = rows.reduce(function (s, t) { return s + t.vio; }, 0);
        showTooltip(e, b,
          dot('#1a3a5c') + tot.toLocaleString() + ' inspections<br>'
          + dot('#c0392b') + vio.toLocaleString() + ' violations<br>'
          + '<strong>' + (tot ? Math.round(vio / tot * 100) : 0) + '%</strong> violation rate'
        );
      })
      .on('mouseleave', hideTooltip);
  }

  svg.on('mousemove', function (e) {
    var tt = document.getElementById('tooltip');
    if (tt.style.display === 'none') return;
    var rect = document.getElementById('map-wrap').getBoundingClientRect();
    positionTooltip(e.clientX - rect.left, e.clientY - rect.top);
  });
}

/* ── Render ── */
function update() {
  var filtered = activeB === 'All'
    ? tanks
    : tanks.filter(function (d) { return d.borough === activeB; });

  var tot = filtered.reduce(function (s, d) { return s + d.tot; }, 0);
  var vio = filtered.reduce(function (s, d) { return s + d.vio; }, 0);

  document.getElementById('s-tot').textContent  = tot.toLocaleString();
  document.getElementById('s-vio').textContent  = vio.toLocaleString();
  document.getElementById('s-rate').textContent = tot ? Math.round(vio / tot * 100) + '%' : '—';
  document.getElementById('s-bld').textContent  = filtered.length.toLocaleString();

  if (mode === 'heat' && geo) {
    renderHeatmap();
  } else {
    renderDots(filtered);
  }
}

function renderHeatmap() {
  var byB = {};
  tanks.forEach(function (d) {
    if (!byB[d.borough]) byB[d.borough] = { t: 0, v: 0 };
    byB[d.borough].t += d.tot;
    byB[d.borough].v += d.vio;
  });

  var rates   = Object.values(byB).filter(function (s) { return s.t > 0; }).map(function (s) { return s.v / s.t; });
  var maxRate = d3.max(rates) || 0.5;
  var cs      = d3.scaleSequential(d3.interpolateRdYlGn).domain([maxRate, 0]);

  d3.select('#geo-layer').selectAll('path')
    .attr('fill', function (d) {
      var s = byB[gbn(d)];
      return (s && s.t) ? cs(s.v / s.t) : '#ccc';
    })
    .attr('fill-opacity', function (d) {
      return activeB === 'All' ? 0.85 : (gbn(d) === activeB ? 0.95 : 0.3);
    })
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5);

  d3.select('#dot-layer').selectAll('circle').remove();

  document.getElementById('legend').innerHTML =
    '<div class="legend-item">Low violation rate</div>'
    + '<div style="width:140px;height:10px;background:linear-gradient(to right,#1a9850,#ffffbf,#d73027);border-radius:5px;"></div>'
    + '<div class="legend-item">High</div>'
    + '<div class="legend-hint">Click a borough to zoom · Scroll to zoom · Drag to pan</div>';
}

function renderDots(filtered) {
  if (geo) {
    d3.select('#geo-layer').selectAll('path')
      .attr('fill', '#b8b0a0')
      .attr('fill-opacity', function (d) {
        return activeB === 'All' ? 0.35 : (gbn(d) === activeB ? 0.5 : 0.12);
      })
      .attr('stroke', '#888')
      .attr('stroke-width', 0.8);
  }

  d3.select('#dot-layer').selectAll('circle')
    .data(filtered, function (d) { return d.bin; })
    .join(
      function (enter) {
        return enter.append('circle')
          .attr('opacity', 0)
          .call(function (el) { el.transition().duration(300).attr('opacity', 0.82); });
      },
      function (upd)  { return upd; },
      function (exit) { return exit.transition().duration(200).attr('opacity', 0).remove(); }
    )
    .attr('cx', function (d) { var p = proj([d.lon, d.lat]); return p ? p[0] : -999; })
    .attr('cy', function (d) { var p = proj([d.lon, d.lat]); return p ? p[1] : -999; })
    .attr('r', 3.5)
    .attr('fill',         function (d) { return d.vio > 0 ? '#c0392b' : '#2d9e6b'; })
    .attr('stroke',       'rgba(255,255,255,0.55)')
    .attr('stroke-width', 0.6)
    .attr('cursor',       'pointer')
    .on('mouseenter', function (e, d) {
      d3.select(this).transition().duration(80).attr('r', 8);
      var rate = d.tot ? Math.round(d.vio / d.tot * 100) : 0;
      showTooltip(e,
        d.borough,
        dot('#1a3a5c') + d.tot + ' inspection' + (d.tot !== 1 ? 's' : '') + '<br>'
        + dot(d.vio > 0 ? '#c0392b' : '#2d9e6b')
        + d.vio + ' violation' + (d.vio !== 1 ? 's' : '') + ' <strong>(' + rate + '%)</strong>'
      );
    })
    .on('mouseleave', function () {
      d3.select(this).transition().duration(80).attr('r', 3.5);
      hideTooltip();
    });

  document.getElementById('legend').innerHTML =
    '<div class="legend-item"><div class="legend-dot" style="background:#2d9e6b;"></div>No violation</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:#c0392b;"></div>Violation issued</div>'
    + '<div class="legend-hint">Click a borough to zoom · Scroll to zoom · Drag to pan</div>';
}

/* ── Borough zoom ── */
function setBorough(b) {
  activeB = b;

  document.querySelectorAll('.boro-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.b === b);
  });

  if (b !== 'All' && geo) {
    var feat = null;
    for (var i = 0; i < geo.features.length; i++) {
      if (gbn(geo.features[i]) === b) { feat = geo.features[i]; break; }
    }
    if (feat) {
      var bounds = pathGen.bounds(feat);
      var x0 = bounds[0][0], y0 = bounds[0][1];
      var x1 = bounds[1][0], y1 = bounds[1][1];
      var scale = Math.min(14, 0.82 / Math.max((x1 - x0) / W, (y1 - y0) / H));
      svg.transition().duration(650).call(
        zoomBehavior.transform,
        d3.zoomIdentity
          .translate(W / 2, H / 2)
          .scale(scale)
          .translate(-(x0 + x1) / 2, -(y0 + y1) / 2)
      );
    }
  } else {
    svg.transition().duration(450).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  update();
}

/* ── Tooltip helpers ── */
function dot(color) {
  return '<span class="tt-dot" style="background:' + color + ';"></span>';
}

function showTooltip(e, title, body) {
  document.getElementById('tt-title').textContent = title;
  document.getElementById('tt-body').innerHTML    = body;
  document.getElementById('tooltip').style.display = 'block';
  var rect = document.getElementById('map-wrap').getBoundingClientRect();
  positionTooltip(e.clientX - rect.left, e.clientY - rect.top);
}

function positionTooltip(x, y) {
  var tt = document.getElementById('tooltip');
  var tw = 224, th = 110;
  tt.style.left = (x + 16 + tw > W ? x - tw - 10 : x + 16) + 'px';
  tt.style.top  = (y + 16 + th > H ? y - th - 10 : y + 16) + 'px';
}

function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}

/* ── Button events ── */
document.querySelectorAll('.boro-btn').forEach(function (btn) {
  btn.addEventListener('click', function () { setBorough(btn.dataset.b); });
});

document.getElementById('vd').addEventListener('click', function () {
  mode = 'dot';
  this.classList.add('active');
  document.getElementById('vh').classList.remove('active');
  update();
});

document.getElementById('vh').addEventListener('click', function () {
  mode = 'heat';
  this.classList.add('active');
  document.getElementById('vd').classList.remove('active');
  update();
});

init();
