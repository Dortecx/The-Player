# Detalles de reproducción con pistas elegidas

[English](selected-track-playback.md) · [Inicio rápido](../README.es.md)

Usá esta guía cuando necesites audio o subtítulos de texto internos de un MKV. El README explica el camino normal; esta página detalla compatibilidad, conversión, caché y navegación.

## Elegir pistas

| Modo | Quién elige | Resultado |
| --- | --- | --- |
| `start.cmd` local | La persona usuaria local, después de **Usar pistas internas locales** | Una sesión protegida con token, solo por loopback y no compartible. La reproducción cruda directa sigue siendo la predeterminada. |
| `LAN.cmd` compartido | El host localhost en **Pistas internas** | Una elección autoritativa de audio/subtítulo de texto; las personas invitadas la ven en solo lectura. |

Hasta aplicar una elección, la reproducción cruda protegida sigue disponible. Aplicar o cambiar una elección recarga la fuente seleccionada y reanuda lo más cerca posible según los metadatos del navegador; no es un cambio de pista sin cortes.

## Preparación y compatibilidad

1. El servidor inspecciona las pistas internas.
2. Genera un VOD HLS CMAF/fMP4 multiplexado para el audio y subtítulo de texto opcional elegidos.
3. Espera a que FFmpeg termine y valida cada referencia del manifiesto, artefacto y `#EXT-X-ENDLIST` antes de iniciar la reproducción.
4. Promueve una versión completa válida a la caché persistente cuando está disponible.

Nunca se reproduce HLS parcial. Si la preparación falla o se cancela, usá la acción explícita de recuperar video original. Esa ruta todavía requiere que el navegador admita el contenedor **y los códecs** originales.

### Ruta de audio y video

Primero se remultiplexan video H.264 `yuv420p` progresivo de 8 bits y audio AAC-LC mono/estéreo compatibles. Si solo un flujo es incompatible, se convierte solo ese; en otro caso se convierten ambos a H.264/AAC. No hay grupos HLS de audio alternativo ni cambios de pista de audio en el navegador.

Cuando hace falta convertir video, FFmpeg prueba NVENC, luego QSV y luego AMF; usa el primer codificador funcional o `libx264`. Las rutas de copia o de solo audio no prueban GPU. Un fallo de GPU reintenta una vez con salida nueva de `libx264` y pone en cuarentena ese backend durante el resto del proceso solo después de un reintento exitoso. Usá `REPRODUCTOR_FORCE_CPU_ENCODER=1` para diagnóstico determinista por CPU. La decodificación sigue siendo solo por software.

### Subtítulos de texto

Los códecs de subtítulos de texto seleccionables son ASS/SSA, SRT/SubRip, WebVTT, MOV text, text y TTML. Los subtítulos de imagen/mapa de bits no están disponibles.

La conversión de texto es independiente: nunca obliga a convertir audio/video. El reproductor muestra los subtítulos elegidos desde un documento WebVTT agregado, completo y protegido, en lugar de eventos TextTrack segmentados de hls.js o nativos. Esto mantiene estable el tiempo de las cues, las cues tardías y las cursivas seguras entre límites de segmentos.

## Caché y privacidad

Las versiones compatibles terminadas viven en la carpeta marcada `hls-cache` junto al launcher portátil. La caché no tiene expulsión automática de forma predeterminada; para recuperar espacio, detené The Player y eliminá solo esa carpeta marcada. Vaciar biblioteca y el apagado normal la conservan.

Las entradas se admiten solo después de una validación completa. Las claves de caché contienen SHA-256 del contenido de origen, índices de pistas elegidas e identidades seguras de codificador/topología; nunca rutas de origen ni tokens de sala. Los mismos bytes de origen y la misma elección de pistas pueden reutilizar una versión terminada sin FFmpeg.

## Reanudación y elemento siguiente

Cada elemento de la playlist conserva su propio checkpoint de navegador vinculado al contenido. Al elegir un destino se puede ofrecer ese checkpoint como candidato de reanudación solo cuando la sala no tiene una posición positiva para ese mismo contenido.

Después de que la transmisión elegida en primer plano queda lista, el servidor puede preparar exactamente el elemento inmediato siguiente. Empareja el audio/subtítulo esperado mediante idioma normalizado más título/disposición cuando están disponibles, y luego solo por idioma no ambiguo. Las coincidencias ambiguas le piden una elección al host en vez de adivinar.

- Elegir un elemento que aún se prepara mantiene sin cambios el elemento en primer plano y su checkpoint.
- La navegación hacia atrás puede retener una preparación posterior.
- Una sesión lista puede re-admitirse sin recodificar.
- Solo la tarjeta siguiente muestra preparando, listo, no disponible o elección requerida.
- Cambiar pistas, vaciar la biblioteca o apagar cancela el trabajo especulativo.

## Progreso y límites

Al principio el reproductor muestra preparación indeterminada. Cuando FFmpeg informa tiempo de salida para una duración de origen conocida, puede mostrar porcentaje, tiempo transcurrido y un restante solo cuando esa estimación es estable. El estado compartido contiene solo progreso normalizado; nunca expone salida FFmpeg, rutas, comandos, tokens, errores sin procesar ni detalles de controladores.

Un trabajo VOD tiene un plazo según duración: al menos 30 minutos y como máximo 12 horas. Al alcanzarlo se produce `job-timeout` y no hay salida parcial reproducible.

Para seguridad de sala compartida, subidas, reglas de firewall y comprobaciones en dos navegadores, consultá los [detalles de reproducción compartida por LAN](lan-shared-playback.es.md).
