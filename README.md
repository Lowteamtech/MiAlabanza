# MiAlabanza Team

App web instalable (iPad, iPhone, Android) para el equipo de alabanza:
repertorios del domingo, cifrados con transposición, notas de arreglo por
instrumento, metrónomo, pedal Bluetooth y uso sin señal.

## Archivos

- `index.html`, `styles.css`, `js/`: la app.
- `js/config.js`: datos de Firebase (vacío = solo este dispositivo).
- `firestore.rules`: reglas de seguridad para Firestore.
- `sw.js`: funcionamiento sin conexión. Al publicar cambios, sube `VERSION`.
- `vendor/`: Firebase y PDF.js incluidos localmente (licencias Apache 2.0).

## Probar en el computador

```bash
python3 -m http.server 8765
```

Y abrir `http://localhost:8765`.
