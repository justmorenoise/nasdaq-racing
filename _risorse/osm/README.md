Dati OpenStreetMap (© OpenStreetMap contributors, ODbL) usati come guida per la scenografia.

Rigenerazione (i file raw non sono versionati):

1. Per ogni circuito in `process.py` (`CENTRES`), scarica le feature con `query.ql`
   (sostituisci `{R}`, `{LAT}`, `{LON}`) su https://overpass-api.de/api/interpreter → `raw/<slug>.json`.
2. Scarica la relazione del circuito:
   `[out:json];relation(around:R,LAT,LON)[type=circuit];out geom;` → `raw/<slug>.circuit.json`.
3. `python3 process.py` → `public/osm/<slug>.json`.

Il gioco allinea i dati al tracciato disegnato a runtime (`src/render3d/osm.ts`).
