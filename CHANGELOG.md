# Cambios

## 1.6.0

- **Menos lag en eventos con mucha gente.** Nuevo **límite de FPS** (BB Hub → Rendimiento): 60 FPS con la ventana delante y 30 FPS con la ventana detrás o en otra cuenta, configurable (30, 60, 90, 120, 144 o sin límite). Antes el juego dibujaba hasta 240 FPS aunque no hiciera falta.
- Ya no hay efectos de desenfoque encima del juego (Smart Bar, barra de estado…): se recalculaban en cada fotograma.
- Una vez dentro del juego, el launcher deja de vigilar cada cambio de la sala para el login.
- El aviso de objetos solo trabaja cuando está activado y tiene objetos que vigilar.

## 1.5.0

- **Arreglado el auto-login**: una vez dentro del juego, el launcher ya no lee ningún campo de contraseña. Antes, si ponías la clave de intercambios, podía guardarla como si fuera tu contraseña y en la siguiente sesión no entraba. Ahora solo lee el login de verdad, y vuelve a leerlo únicamente si regresas a la pantalla de inicio de sesión.
- La ventana de la clave de intercambios ya no esconde la Smart Bar.
- Nuevo ajuste opcional **Animaciones siempre activas** (apagado por defecto): si Windows tiene desactivados los «Efectos de animación», el launcher se queda quieto y el juego puede no mostrar algunos efectos; con este ajuste se ven igual que en cualquier otro PC.
- Diagnóstico muestra si Windows tiene las animaciones desactivadas y si la aceleración gráfica está activa.
- **Borrar caché** en dos sitios, sin cerrar ninguna sesión: en los Ajustes del launcher (launcher + todas tus cuentas) y dentro del juego en el BB Hub → Cliente (esa cuenta, y recarga el juego).

## 1.4.0

- **Screen Marker de Sendero Oculto rehecho**: una sola barra dentro del juego (se arrastra desde ⋮⋮) con lápiz, marcas ✕ ✓ ? ◎, 5 colores, 3 grosores, deshacer y borrar.
- Cambio rápido **lápiz ⇄ ratón** con clic derecho o la tecla Espacio; en modo ratón, mantén Shift para dibujar mientras la pulsas. Ctrl+Z deshace.
- **Marcar zona** pone una liana (como las del juego) en vez de un círculo; su tamaño se elige con los botones de grosor.
- Se abre desde el BB Hub → Minijuegos → Sendero Oculto.

## 1.3.0

- Nueva pestaña **Avisos** en el BB Hub: suena un aviso suave cuando cae un objeto que le hayas enseñado, y el botón del juego parpadea en la barra de tareas si estás en otra ventana.
- Para enseñarle un objeto: **Aprender objeto** y clic en él dentro del juego. El launcher reconoce la imagen original del objeto dentro del juego, no los colores de la pantalla, así que la lluvia, la niebla o las sombras no le afectan. Sale con su miniatura para que veas qué ha aprendido.
- Opción **«también otros que caigan»** para avisar de cualquier objeto que el juego ponga en el mismo sitio.
- Volumen ajustable, con botón de prueba. Si tienes el juego silenciado, el aviso suena por el launcher.
- Solo avisa: no recoge nada, no hace clic y no mueve el ratón.

## 1.2.0

- Nueva pestaña **Autoclick** en el BB Hub: activarlo, la velocidad y las teclas, todo en un sitio.
- **Teclas del autoclick configurables**: elige qué tecla guarda la posición, cuál empieza y cuál para (F1–F12, letras, números, Insert, Inicio… o la rueda y los botones laterales del ratón).
- **Más potencia a 1 ms**: el modo máximo hace 8 clics por tanda en vez de 6.
- El intervalo del autoclick se ha movido de los Ajustes del launcher al BB Hub.

## 1.1.0

- Autoclick: nuevo ajuste **Intervalo del autoclick** en Ajustes (de 1 a 1000 ms). Si el PC se traba con el autoclick, súbelo (por ejemplo 30–100 ms).

## 1.0.0

Primera versión pública.

- Perfiles con sesión propia y auto-login (contraseñas cifradas con el sistema de Windows).
- Smart Bar configurable: botones de texto con `{user}`, botones de upper rápido para los 17 colores, ping real al servidor y atajos de teclado configurables.
- BB Hub: configuración de la Smart Bar, calibración guiada del upper, copia de configuración entre perfiles y ajustes de vista del cliente.
- Autoclick integrado (desactivado por defecto): F3 guarda la posición, F1 empieza y F2 para. Dentro de BoomBang los clics se envían directamente al juego sin mover el ratón.
- 7 diseños animados para el launcher: Galaxy Crystal, Aurora Boreal, Inferno, Océano, Sakura, Neon Retro y Halloween.
- Instalador para Windows (`BoomBang-Launcher-Setup.exe`): no hace falta instalar nada más.
- Actualizaciones automáticas desde GitHub: aviso con novedades y botón «Actualizar», sin perder perfiles ni ajustes.
