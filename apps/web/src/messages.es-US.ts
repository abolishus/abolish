// apps/web's strings in US Spanish (P2-28 part 4), with `en-US`'s keys
// (src/messages.ts), addressing the reader as `tú` as the everyday register
// does ([[language]], Voice).

import type { Messages } from "./messages.ts";

export const esUS: Messages = {
  siteName: "Abolish",
  homeTitle: "Pregunta lo que sea. Cualquiera puede responder. Cualquiera puede revisar el conteo.",
  homeLede:
    "Para tus amigos, tu calle, tu club o tu clase. Cada conteo es público, así que nadie tiene que fiarse de la palabra de otro sobre el resultado.",
  homeAsk: "Hacer una pregunta",
  homeBrowse: "Ver preguntas",
  appDescription:
    "Pregunta lo que sea. Cualquiera puede responder. Cualquiera puede revisar el conteo.",
  homeNonBinding: "No vinculante y a cargo de la ciudadanía.",
  homeStreamTitle: "Lo que la gente pregunta",
  homeStreamLede: "Las preguntas abiertas más recientes.",
  homeStreamPick:
    "Elige una respuesta en cualquier tarjeta para abrirla en la app de votación. No se envía nada hasta que emitas tu boleta ahí.",
  homeStreamAll: "Ver todas las preguntas",
  homeFeaturedAll: "Más de las más respondidas",
  homeStreamEmpty:
    "No hay preguntas abiertas en este momento. Cuando alguien haga una, aparecerá aquí.",
  homeListUnavailable:
    "No se pudieron cargar las preguntas más recientes en este momento. Vuelve a intentarlo dentro de un rato.",
  trustTitle: "Por qué puedes confiar en una encuesta informal",
  trustLede:
    "Una pregunta sobre los árboles de la calle se sella, se publica y se cuenta igual que un referéndum. Esto es lo que pasa con una respuesta, en cuatro pasos.",
  trustHowItWorks: "Cómo funciona, en detalle",
  trustLabel: "Qué pasa con una respuesta",
  trustStep: "Paso {step} de {total}",
  trust1Title: "Sellada en tu dispositivo",
  trust1Body:
    "Cuando respondes, la app de votación la sella en tu propio dispositivo antes de que vaya a ninguna parte. Lo que viaja es una caja cerrada, no tu respuesta.",
  trust1Detail:
    "El detalle: se divide en partes, cada una cifrada para uno de los puestos de custodio de la encuesta.",
  trust2Title: "Publicada en un tablero público",
  trust2Body:
    "Cada respuesta sellada va a un tablero público que cualquiera puede leer. Tú guardas un código de seguimiento, para encontrar la tuya ahí y ver que sigue ahí.",
  trust2Detail:
    "El detalle: cada entrada extiende una cadena de hashes, así que quitar o cambiar una se nota.",
  trust3Title: "Se abre solo después de que cierra la encuesta",
  trust3Body:
    "El conteo se desbloquea solo cuando suficientes puestos de custodio de la encuesta, cada uno con una parte de cada respuesta sellada, trabajan juntos después del cierre. Ningún puesto puede abrirlo por sí solo. Durante el lanzamiento, Abolish opera todos los puestos, así que estas encuestas son privadas para todos excepto para nosotros. Custodios independientes tomarán el relevo antes de la primera votación cívica, y quienes pregunten podrán añadir sus propios custodios.",
  trust3Detail: "El detalle: se necesitan {threshold} de los {seats} puestos.",
  trust4Title: "Cualquiera lo vuelve a contar",
  trust4Body:
    "Cualquiera puede tomar el tablero público y volver a contarlo con el verificador de código abierto. Si su conteo coincide con el nuestro, nadie tiene que fiarse de nuestra palabra.",
  trust4Detail: "El detalle: el verificador revisa cada prueba además del conteo.",
  graphicAnswer: "Tu respuesta",
  graphicOption: "Sí",
  graphicSealed: "Lo que sale de tu dispositivo",
  graphicBoard: "El tablero público",
  graphicYours: "La tuya",
  graphicOpen: "Para abrir el conteo",
  graphicSeats: "{threshold} de {seats} puestos",
  graphicPublished: "Conteo publicado",
  graphicRecount: "Recuento de cualquiera",
  graphicMatch: "Coinciden.",
  navHowItWorks: "Cómo funciona",
  howEyebrow: "Cómo funciona · {count} secciones",
  howTitle: "Cómo una boleta se mantiene secreta, queda registrada y se cuenta en público",
  howLede:
    "Abolish está hecho para que no tengas que confiar en él. Esta página sigue una boleta por cada etapa, dice qué prueba cada paso y qué no, y termina con las debilidades que no hemos resuelto. Abolish todavía está en construcción: donde un paso aún no funciona, lo dice.",
  howContents: "En esta página",
  howStep: "Paso {step}",
  howSceneLabel: "{section}, paso a paso",
  howTiersMark: "Quién puede votar",
  howTiersTitle: "Quién se cuenta y qué tan seguros estamos",
  howTiersIntro:
    "Abolish no puede verificar a todos de la misma forma, así que cada resultado dice cómo se verificó a sus votantes, con un resultado por nivel. Los niveles nunca se suman.",
  howTiers1Title: "Nivel 0: una llave de acceso",
  howTiers1Body:
    "Cualquiera puede crear una cuenta con una llave de acceso, y cualquiera puede crear varias. Un resultado de Nivel 0 cuenta cuentas, no personas, y lo dice. Las encuestas de hoy funcionan en el Nivel 0.",
  howTiers2Title: "Nivel 1: con aval (planeado)",
  howTiers2Body:
    "Las personas ya verificadas podrán avalar a alguien, así que inventar un votante requiere cómplices dispuestos a poner en juego su propia reputación. Este nivel está en construcción.",
  howTiers3Title: "Nivel 2: un documento oficial (planeado)",
  howTiers3Body:
    "Cada votante probará en su propio teléfono, con una prueba de conocimiento cero, que tiene un pasaporte o identificación firmados por un gobierno con un chip legible. La prueba no muestra ni el documento ni a la persona, solo que el mismo documento no se ha usado para unirse dos veces. Este nivel está en construcción.",
  howTiers4Title: "Lado a lado, nunca sumados",
  howTiers4Body:
    "El resultado de cada nivel se informa por separado, con su número de boletas y quién podía votar. Una sola cifra mezclada reflejaría sobre todo a quien abriera más cuentas.",
  howSecrecyMark: "Secreto del voto",
  howSecrecyTitle: "Tu elección se sella en tu propio dispositivo",
  howSecrecyIntro:
    "El secreto no depende de que este sitio web se porte bien. La app de votación sella tu elección en el dispositivo que te la muestra, antes de enviar nada.",
  howSecrecy1Title: "Eliges en la app de votación",
  howSecrecy1Body:
    "Las boletas se emiten solo en la app de votación, nunca en este sitio web. La app muestra la pregunta y las opciones exactamente como las fija la definición publicada de la encuesta, y tu elección se queda en la memoria de tu dispositivo.",
  howSecrecy2Title: "Tu elección queda fijada en un compromiso",
  howSecrecy2Body:
    "La app convierte tu elección en un compromiso: un valor que fija la elección pero la oculta por completo, sin importar la potencia de cómputo que llegue después. El compromiso es lo que va al tablero público.",
  howSecrecy3Title: "La clave se reparte entre custodios",
  howSecrecy3Body:
    "Los números que abren el compromiso se dividen en partes, una por cada puesto de custodio, y cada parte se cifra solo para su puesto, con un cifrado pensado para resistir tanto a las computadoras cuánticas futuras como a las actuales. Ningún puesto puede abrir una boleta por sí solo. Durante el lanzamiento, Abolish opera todos los puestos, así que estas boletas son privadas para todos excepto para nosotros (sección 5).",
  howSecrecy4Title: "Con pruebas de que es un voto válido",
  howSecrecy4Body:
    "La app adjunta pruebas de conocimiento cero de que el compromiso contiene una respuesta permitida, para que una boleta no pueda llevar cien votos ni uno negativo, y de que quien vota pertenece al electorado de la encuesta, sin decir qué respuesta ni qué miembro. Tu cuenta nunca forma parte de la boleta.",
  howChallengeMark: "Emitida según tu intención",
  howChallengeTitle: "Comprobar que la app selló lo que elegiste",
  howChallengeIntro:
    "Nadie puede ver dentro de una boleta sellada, ni siquiera tú. Una comprobación te deja abrir una y ver qué selló realmente la app, a cambio de esa boleta.",
  howChallenge1Title: "La app sella primero y luego pregunta",
  howChallenge1Body:
    "Después de sellar tu elección, la app pregunta si emitir la boleta o comprobarla. Ya se comprometió con la boleta sellada antes de saber qué vas a escoger.",
  howChallenge2Title: "Comprobar abre la boleta",
  howChallenge2Body:
    "Si la compruebas, la app revela la elección y cada número aleatorio que usó, para que la boleta sellada se pueda reconstruir con ellos y comparar. Una boleta comprobada nunca se cuenta.",
  howChallenge3Title: "Luego vuelves a votar",
  howChallenge3Body:
    "La app sella tu elección de nuevo, con números aleatorios nuevos, y vuelve a preguntar. Puedes comprobar cuantas veces quieras antes de emitir.",
  howChallenge4Title: "Por qué se descubre una app tramposa",
  howChallenge4Body:
    "Una app que cambiara votos no puede saber qué boletas se comprobarán, así que cada comprobación es una oportunidad de descubrirla. Pocos votantes comprueban, así que esta protección es estadística. Publicar la apertura de una boleta comprobada es decisión tuya, está desactivado de forma predeterminada y solo ocurre después de que cierra la encuesta.",
  howRecordedMark: "Registrada tal como se emitió",
  howRecordedTitle: "Encontrar tu boleta en el tablero público",
  howRecordedIntro:
    "Cada encuesta tiene un tablero público que solo crece. Tu comprobante indica la entrada que contiene tu boleta sellada, para que puedas verificar que está ahí y que sigue ahí.",
  howRecorded1Title: "Cada boleta se vuelve una entrada",
  howRecorded1Body:
    "Cada boleta sellada se añade al tablero de la encuesta como una entrada numerada. Cada entrada extiende una cadena de hashes y un árbol de Merkle, así que cambiar o quitar una anterior se nota.",
  howRecorded2Title: "Guardas un comprobante",
  howRecorded2Body:
    "Cuando se añade tu boleta, el operador del tablero firma un comprobante que indica su entrada y el tablero que la contiene. La app verifica que la entrada de verdad esté en ese tablero antes de decirte que se recibió la boleta, y guarda el comprobante.",
  howRecorded3Title: "Prueba el registro, no tu elección",
  howRecorded3Body:
    "Con el comprobante y una breve prueba de inclusión, cualquiera puede verificar que un tablero posterior todavía contiene tu entrada. El comprobante no dice nada de cómo votaste, así que no es prueba de un voto. Aun así, guárdalo para ti: apunta a tu boleta en el tablero, así que quien lo vea puede detectar cualquier boleta posterior que emitas en la misma encuesta.",
  howRecorded4Title: "Anclado en Ethereum (planeado)",
  howRecorded4Body:
    "Cada hora, la raíz del tablero se anclará en Ethereum. Una entrada con comprobante que falte en un tablero anclado posterior es evidencia de manipulación que cualquiera puede publicar. El anclaje por hora todavía no está en funcionamiento.",
  howCountedMark: "Contada tal como se registró",
  howCountedTitle: "Contar sin abrir una sola boleta",
  howCountedIntro:
    "El conteo es aritmética sobre boletas selladas. Los custodios abren solo los totales, y cada paso publica algo que cualquiera puede verificar.",
  howCounted1Title: "Los compromisos se suman",
  howCounted1Body:
    "Los compromisos se pueden sumar sin abrirlos. Sumar el compromiso de cada boleta contada da un total sellado por cada nivel.",
  howCounted2Title: "Cada puesto suma sus partes",
  howCounted2Body:
    "Después de que cierra la encuesta, cada puesto de custodio suma las partes que recibió y publica la suma. Cualquiera puede verificar cada suma con valores públicos que llevaban las boletas, así que un puesto no puede publicar una equivocada sin que se note.",
  howCounted3Title: "{threshold} de {seats} puestos abren los totales",
  howCounted3Body:
    "Cuando {threshold} de los {seats} puestos han publicado, sus sumas abren el total de cada nivel, y solo los totales: no se abre ninguna boleta individual. Durante el lanzamiento, Abolish opera los {seats} puestos. Custodios independientes tomarán el relevo antes de la primera votación cívica, y quienes pregunten podrán añadir sus propios custodios.",
  howCounted4Title: "Cualquiera puede volver a contar",
  howCounted4Body:
    "El verificador de código abierto toma el tablero público y revisa cada prueba, cada suma y el conteo. Si su resultado coincide con el nuestro, nadie tiene que fiarse de nuestra palabra. Después, los puestos destruyen sus claves y partes, aunque nadie puede verificar que lo hicieron.",
  howSurvivesMark: "Si tumban abolish.us",
  howSurvivesTitle: "Lo que sobrevive sin nosotros",
  howSurvivesIntro:
    "Un registro que desaparece con quien lo publica no vale mucho como registro. Estas piezas buscan que la votación, el tablero y el conteo duren más que nuestro dominio, nuestros servidores y nosotros. La mayoría todavía está en construcción.",
  howSurvives1Title: "Encuestas registradas en cadena (planeado)",
  howSurvives1Body:
    "El hash de la definición de cada encuesta y las claves de sus custodios se registrarán en una red de capa 2 de Ethereum, para que las reglas de una encuesta no se puedan cambiar después de que abre.",
  howSurvives2Title: "Enviar sin nosotros (planeado)",
  howSurvives2Body:
    "Si nuestros servidores rechazan una boleta, la app de votación podrá enviarla directamente a los contratos, sin pasar por nosotros.",
  howSurvives3Title: "Copias del tablero (planeado)",
  howSurvives3Body:
    "El tablero se replicará en IPFS y en un archivo permanente, con su raíz anclada en Ethereum, y cualquiera podrá operar un nodo ligero que lo sirva.",
  howSurvives4Title: "Un verificador que no nos necesita (planeado)",
  howSurvives4Body:
    "El verificador funcionará solo con la cadena e IPFS, con nuestros servidores y dominio fuera de línea. Borrar nuestra base de datos no hace perder ningún resultado: todo lo que afecta a uno se puede reconstruir a partir de las copias públicas.",
  howWeakMark: "Lo que sigue pendiente",
  howWeakTitle: "Dónde es débil, dicho con claridad",
  howWeakIntro:
    "Ningún sistema de votación está a salvo de todo. Estos son los límites que conocemos hoy. Cuando un límite tiene una entrada en nuestro modelo de amenazas público, su número aparece al lado, y esta lista cambia cuando ellas cambian.",
  howWeakLimit: "Qué lo limita:",
  howWeakThreats: "Entradas del modelo de amenazas:",
  howWeakPanelTitle: "Durante el lanzamiento, tenemos todos los puestos de custodio",
  howWeakPanelMeans:
    "Abolish opera todos los puestos del panel de lanzamiento, así que podríamos abrir cualquier boleta individual, y cualquiera que pueda obligarnos podría hacernos abrirla.",
  howWeakPanelLimit:
    "Una boleta abierta muestra qué respondió una identidad de votación anónima, no quién es, a menos que se vincule con la dirección de red de la que llegó la boleta (consulta el límite sobre direcciones más abajo). Custodios independientes tomarán el relevo antes de la primera votación cívica, pero las encuestas abiertas antes de eso se podrán seguir leyendo con nuestras partes hasta que las destruyamos, algo que nadie puede verificar.",
  howWeakSybilTitle: "El Nivel 0 se puede falsificar a gran escala",
  howWeakSybilMeans:
    "Quien pueda conseguir varias direcciones de correo, y números de teléfono donde pedimos uno, puede abrir varias cuentas. Un resultado de Nivel 0 describe lo que dijeron las cuentas, no lo que piensa la gente.",
  howWeakSybilLimit:
    "Siempre se informa por separado y se etiqueta como tal, nunca mezclado en un total.",
  howWeakDocumentsTitle: "Una persona puede tener dos documentos",
  howWeakDocumentsMeans:
    "El Nivel 2 deja que cada documento se una una vez, no cada persona. Alguien con dos documentos válidos, como pasaportes de dos países, se une dos veces, y también quien tenga el documento de otra persona o una copia de los datos de su chip. Un gobierno que emite documentos podría emitir otros de más.",
  howWeakDocumentsLimit:
    "Sin mitigar: un resultado de Nivel 2 cuenta documentos y se informa por separado junto a su nivel. El Nivel 2 aún no está abierto.",
  howWeakWatchTitle: "Alguien puede verte votar",
  howWeakWatchMeans:
    "Un comprobante prueba que tu boleta quedó registrada, no tu elección. Pero nada impide que alguien vigile tu pantalla o te exija tu comprobante.",
  howWeakWatchLimit:
    "Puedes volver a votar más tarde y solo cuenta tu última boleta, así que un voto que alguien vio no tiene por qué ser el definitivo. Pero quien haya visto tu comprobante puede ver que volviste a votar, y no se impide vender un voto en secreto. Es una defensa parcial, no una solución.",
  howWeakColludeTitle: "Los custodios podrían coludirse",
  howWeakColludeMeans:
    "Cualquier grupo de puestos que alcance el umbral de una encuesta, actuando en conjunto, podría abrir boletas individuales, no solo totales.",
  howWeakColludeLimit:
    "Cada suma que publica un puesto es pública y se verifica, y la página de cada encuesta dice cuántos puestos se necesitan.",
  howWeakDeviceTitle: "Un dispositivo comprometido",
  howWeakDeviceMeans:
    "Un malware en el dispositivo de un votante podría cambiar una elección antes de sellarla.",
  howWeakDeviceLimit:
    "Las comprobaciones descubren una app tramposa, pero solo si la gente las usa. La mayoría de los votantes no lo hará, así que la protección es estadística.",
  howWeakAnchorTitle: "Antes de anclar el tablero",
  howWeakAnchorMeans:
    "Hasta que la raíz de un tablero se ancla en Ethereum, el tablero es solo nuestra palabra, y se podría descartar una entrada.",
  howWeakAnchorLimit:
    "Guarda tu comprobante: un tablero posterior que omita una entrada con comprobante es evidencia que cualquiera puede publicar. El anclaje por hora todavía no está en funcionamiento.",
  howWeakNetworkTitle: "Vemos de dónde viene una boleta",
  howWeakNetworkMeans:
    "Nuestros servidores reciben cada boleta con la dirección de red desde la que se envió, lo que podría ayudar a vincular una boleta con una persona.",
  howWeakNetworkLimit:
    "Sin mitigar. El registro de solicitudes de nuestra propia API omite las direcciones en la ruta de las boletas, pero nuestro proveedor de hosting y el borde de red que está delante podrían verlas o registrarlas, y los puestos de custodio reciben cada boleta con su dirección. No puedes verificar lo que guardamos: una VPN o Tor oculta tu dirección de nosotros.",
  howWeakTurnoutTitle: "La participación es autoseleccionada",
  howWeakTurnoutMeans:
    "Los votantes eligen participar, así que un resultado describe a quienes respondieron, no a todos. Los resultados son orientativos y no obligan a nadie.",
  howWeakTurnoutLimit: "Cada resultado indica su nivel y cuántos podían votar.",
  howVerify: "Cómo verificar un resultado por tu cuenta",
  howSource:
    "El protocolo, su modelo de amenazas (con cada entrada mencionada arriba) y el código fuente están publicados abiertamente en github.com/abolishus/abolish.",
  navVerify: "Verifícalo tú",
  recountEyebrow: "Verifícalo tú",
  recountTitle: "Vuelve a contar una encuesta sin nosotros",
  recountLede:
    "El verificador es un programa de código abierto que cualquiera puede ejecutar. Lee el tablero de una encuesta, sus anclajes en Ethereum y sus pruebas, revisa cada una y da la misma respuesta sin importar quién lo ejecute. Nunca le pide nada a nuestros servidores.",
  recountNotYetTitle: "Todavía no para las encuestas de este sitio",
  recountNotYetBody:
    "Nuestros servidores todavía no anclan los tableros en Ethereum, así que el verificador no encuentra ninguna encuesta nuestra que revisar. Hasta que el anclaje funcione, la página del tablero de cada encuesta revisa lo que puede de lo que dice nuestro servidor, y el verificador revisa una elección de prueba en una cadena local con cada cambio a nuestro código.",
  recountRunMark: "Ejecútalo",
  recountRunTitle: "Cuatro comandos, un veredicto por encuesta",
  recountRunLede:
    "Necesitas Git, Node.js y Vite+, las herramientas con las que se compila el código. El verificador todavía no se publica como un programa para instalar, así que se ejecuta desde una copia del código fuente.",
  recountStep1Title: "Consigue el código fuente",
  recountStep1Body: "Copia el código e instala lo que necesita, en las versiones exactas que fija.",
  recountStep2Title: "Copia los tableros",
  recountStep2Body:
    "El nodo comunitario lee cada punto de control anclado en Ethereum y copia desde IPFS los archivos del tablero que nombra, revisando cada bloque contra su dirección.",
  recountStep3Title: "Verifica cada encuesta",
  recountStep3Body:
    "Para cada encuesta que nombran los anclajes, el nodo reúne sus datos de las dos cadenas y de los tableros copiados, ejecuta el verificador y guarda los datos y el informe uno al lado del otro.",
  recountStep4Title: "Revisa una de nuevo por separado",
  recountStep4Body:
    "El verificador solo, con los datos que reunió el nodo, hace las mismas revisiones. Imprime un informe y un resumen, y su código de salida es el veredicto.",
  recountValueL1:
    "Un nodo de Ethereum en el que confíes para decir qué bloque es definitivo. Lo mejor es uno tuyo.",
  recountValueL2:
    "Un nodo de la red en la que se registran las encuestas, en el que se confía por los registros que guarda.",
  recountValueGateway:
    "Cualquier pasarela de IPFS, o la del propio nodo. Se revisa cada bloque que envía.",
  recountValueAnchor:
    "La dirección del ancla del tablero, tal como la fija una versión del código.",
  recountValueRegistry:
    "La dirección del registro de elecciones, tal como la fija una versión del código.",
  recountValuePoll: "El ID de la encuesta, en hexadecimal en minúsculas.",
  recountExitCaption: "Qué significa el código de salida",
  recountExitCode: "Código",
  recountExitVerdict: "Veredicto",
  recountExit0: "Verificada",
  recountExit0Means: "Pasaron todas las revisiones.",
  recountExit20: "Fallida",
  recountExit20Means: "Falló una revisión. El informe dice cuál y por qué.",
  recountExit21: "No verificable",
  recountExit21Means:
    "Algo no se pudo revisar, como una copia que falta o un dato que nada prueba. Nunca cuenta como aprobado.",
  recountExit22: "Rechazada",
  recountExit22Means: "Los datos estaban mal formados, así que no hay informe.",
  recountExit64: "Uso",
  recountExit64Means: "El comando no era uno de los que acepta, o se le pidió su ayuda.",
  recountExitOther:
    "Cualquier otro código es una falla del propio verificador y no dice nada de la encuesta.",
  recountChecksMark: "Qué revisa",
  recountChecksTitle: "{count} grupos de revisiones, del código al conteo",
  recountChecksLede:
    "Cada uno está descrito en la especificación del verificador, que basta para escribir tu propio verificador en cualquier lenguaje. Una revisión que no puede hacer se informa, nunca se da por aprobada.",
  recountCheck1Title: "La app de votación y los contratos",
  recountCheck1Body:
    "La app de votación que sirve un sitio es una versión firmada, y cada contrato que usa la encuesta es la compilación de esa versión a partir de código revisado.",
  recountCheck2Title: "La definición de la encuesta",
  recountCheck2Body:
    "Sus preguntas, respuestas, plazo, electorado y custodios son los que se registraron antes de que abriera, y nada de eso cambió desde entonces.",
  recountCheck3Title: "La ceremonia de claves",
  recountCheck3Body:
    "Las claves de los custodios se crearon en público, cada prueba de su registro es válida y participaron suficientes puestos.",
  recountCheck4Title: "El tablero, sus anclajes y el archivo",
  recountCheck4Body:
    "Cada entrada está en su lugar en una sola cadena sin cortes, cada punto de control coincide con su anclaje en Ethereum y el archivo guarda lo que nombran los anclajes.",
  recountCheck5Title: "Las boletas",
  recountCheck5Body:
    "Cada boleta prueba que su votante está en el electorado sin decir quién es, contiene un conjunto válido de respuestas y llegó dentro del plazo de la encuesta.",
  recountCheck6Title: "Volver a votar y boletas revisadas",
  recountCheck6Body:
    "Solo puede contar la boleta más reciente de cada votante, y nunca se cuenta una boleta abierta para revisar la app.",
  recountCheck7Title: "El conteo",
  recountCheck7Body:
    "Los totales se calculan de nuevo solo con las boletas contadas, y cada apertura publicada de un total debe coincidir con ellos.",
  recountCheck8Title: "El informe",
  recountCheck8Body:
    "Los resultados se dan por nivel, nunca sumados entre niveles, con los conteos pequeños señalados y todo lo que no pudo revisar en una lista.",
  recountTrustMark: "En qué confía",
  recountTrustTitle: "En qué confía y en qué no",
  recountTrustLede:
    "Un resultado vale lo que valen los datos con los que se revisó, así que el informe nombra cada dato que nada probó, y el veredicto no llega a verificada mientras haya alguno.",
  recountTrustServers: "Nuestros servidores",
  recountTrustServersMeans:
    "En nada. El verificador nunca pide nada a nuestros servidores ni dominios, salvo, cuando le pides revisar una app de votación servida, la propia app, que luego juzga byte por byte.",
  recountTrustL1: "Tu nodo de Ethereum",
  recountTrustL1Means:
    "En qué bloque es definitivo. Los anclajes y todo lo demás que se lee de Ethereum se prueban contra ese bloque.",
  recountTrustL2: "Tu nodo de la red de la encuesta",
  recountTrustL2Means:
    "En los registros que guarda hasta su bloque definitivo, como la definición de la encuesta. Lo que una prueba no cubre se nombra en el informe.",
  recountTrustGateways: "Pasarelas de IPFS",
  recountTrustGatewaysMeans:
    "En nada sobre el tablero: cada bloque se revisa contra su dirección, así que una pasarela solo puede dejar de responder. Sí ve qué bloques lees, y por tanto qué encuesta.",
  recountNodeMark: "Nodo comunitario",
  recountNodeTitle: "Ejecuta un nodo, guarda una copia",
  recountNodeLede:
    "El nodo comunitario de los comandos de arriba es el verificador, una copia de los tableros y un lector de las cadenas, sin base de datos y sin cuenta. Cada uno que se deja funcionando es otra copia del registro que no depende de nosotros.",
  recountNodeServeTitle: "Comparte tu copia",
  recountNodeServeBody:
    "Desde la misma copia del código, después de copiar los tableros, esto entrega cada bloque que guarda el nodo, por su dirección, y los informes que escribió el paso de verificación.",
  recountNodeOpen:
    "Solo escucha en tu propia máquina, a menos que le indiques otra cosa. Si lo abres a otros, pon delante un proxy que limite cada dirección: por sí solo, un visitante puede ocupar todas las conexiones.",
  recountNodeKeeps: "Guarda",
  recountNodeKeepsMeans:
    "Los archivos de los tableros que trajo el paso de copia, con cada bloque revisado contra su dirección. Solo añade más cuando vuelves a ejecutar ese paso.",
  recountNodeServes: "Entrega",
  recountNodeServesMeans:
    "Cada bloque que guarda a cualquier cliente de IPFS que lo pida, y el último informe de cada encuesta. No anota nada sobre quién pidió qué.",
  recountNodeVerifies: "Verifica",
  recountNodeVerifiesMeans:
    "Cada encuesta que nombran los anclajes, cada vez que ejecutas el paso de verificación. Todavía no lo hace por su cuenta.",
  recountNodeNeeds: "Necesita",
  recountNodeNeedsMeans:
    "Una máquina encendida, un nodo de Ethereum, un nodo de la red de la encuesta y disco para los tableros que copies. Reinícialo para que entregue lo que añadió una copia posterior.",
  recountSource:
    "El código fuente del verificador está en packages/verifier y su especificación en docs/spec/verifier.md, ambos publicados en github.com/abolishus/abolish.",
  navKeys: "Quién tiene las llaves",
  keysEyebrow: "Fideicomisarios · El panel de lanzamiento",
  keysTitle: "Durante el lanzamiento, solo Abolish tiene la llave",
  keysLede:
    "Cada respuesta se sella para que solo los puestos fideicomisarios de la encuesta, trabajando juntos, puedan abrirla. Hasta que se nombren fideicomisarios independientes, todos los puestos son nuestros, así que por ahora las respuestas a una encuesta de aquí no son secretas para nosotros.",
  keysFigureSeats: "Puestos fideicomisarios",
  keysFigureSeatsScope: "todos a cargo de Abolish",
  keysFigureThreshold: "Necesarios para abrir un conteo",
  keysFigureThresholdScope: "cualesquiera {threshold} de los {seats}",
  keysFigureAlone: "Puestos que pueden abrir algo solos",
  keysFigureAloneScope: "una parte por sí sola no revela nada",
  keysFigureOthers: "Puestos en manos de otros",
  keysFigureOthersScope: "hasta que se nombren fideicomisarios independientes",
  keysSeatsMark: "Los puestos",
  keysSeatsTitle: "{seats} puestos, y cualesquiera {threshold} abren un conteo",
  keysSeatsLede:
    "Un puesto es el nodo de un fideicomisario. Cuando respondes, la app de votación divide lo que abre tu respuesta sellada en una parte para cada puesto, cada una cifrada solo para ese puesto.",
  keysSeat1Title: "Ningún puesto abre nada solo",
  keysSeat1Body:
    "Una parte, o cualesquiera {fewer} de ellas, no revela nada de una respuesta. Ningún puesto por sí solo puede abrir un conteo antes de tiempo, ni nunca.",
  keysSeat2Title: "{threshold} puestos abren los totales",
  keysSeat2Body:
    "Cuando una encuesta cierra, cada puesto suma sus partes y {threshold} de esas sumas abren cada total. Cada apertura va firmada por el puesto que la hizo y se comprueba contra el tablero, así que una equivocada se ve en público.",
  keysSeat3Title: "Los mismos {threshold} podrían abrir una respuesta",
  keysSeat3Body:
    "Los puestos que juntos alcanzan el umbral podrían abrir respuestas sueltas, no solo totales. Por eso importa quién los tiene, y por eso la página de cada encuesta dice cuántos hacen falta.",
  keysOursMark: "Durante el lanzamiento",
  keysOursTitle: "Por ahora, todos los puestos son nuestros",
  keysOursLede:
    "Todavía no se han nombrado fideicomisarios independientes, así que todos los puestos del panel de lanzamiento están a cargo de Abolish. Esto es lo que significa, dicho con claridad.",
  keysOursCould: "Lo que podríamos hacer",
  keysOursCouldMeans:
    "Abrir cualquier respuesta suelta de una encuesta bajo el panel de lanzamiento, mientras está abierta y hasta que se destruyan sus partes.",
  keysOursShows: "Lo que muestra una respuesta abierta",
  keysOursShowsMeans:
    "Lo que respondió una identidad de votación anónima, no quién es, salvo que se una a la dirección de red desde la que llegó la boleta. Nuestros puestos reciben cada boleta con esa dirección y prometen no guardarla, una promesa que nadie puede comprobar.",
  keysOursCompel: "Quién podría obligarnos",
  keysOursCompelMeans:
    "Cualquiera que pueda obligarnos, por ley o por la fuerza, podría hacernos abrir respuestas o entregar las partes antes de que se destruyan.",
  keysOursPolls: "Qué encuestas",
  keysOursPollsMeans:
    "Solo las encuestas cotidianas. Los referendos cívicos y las votaciones de organizaciones esperan a un panel independiente, y la página de cada encuesta dice quién tiene su llave.",
  keysPromiseMark: "Lo que prometemos",
  keysPromiseTitle: "Nuestros compromisos, y lo que nadie puede comprobar",
  keysPromiseLede:
    "Son promesas, no pruebas. Donde algo se puede comprobar, dice cómo; donde no, también lo dice.",
  keysPromise1Title: "Máquinas, proveedores y custodios distintos",
  keysPromise1Body:
    "Ninguna máquina, proveedor de alojamiento ni persona que pueda llegar a un puesto tiene {threshold} puestos. Eso protege contra una intrusión o una persona desleal, no contra quien pueda obligar a la propia Abolish.",
  keysPromise1Check: "Nadie de fuera puede comprobarlo.",
  keysPromise2Title: "Partes destruidas tras cada conteo final",
  keysPromise2Body:
    "Cuando se publica el conteo final de una encuesta, cada puesto destruye sus llaves y partes y firma una declaración que lo dice.",
  keysPromise2Check:
    "Las declaraciones firmadas están en el tablero de la encuesta. La destrucción en sí nadie la puede comprobar.",
  keysPromise3Title: "Dicho en cada encuesta",
  keysPromise3Body:
    "La página de cada encuesta dice que durante el lanzamiento solo Abolish tiene la llave de esa encuesta, en las páginas cotidianas además de en la evidencia.",
  keysPromise3Check: "Cualquiera puede verlo en la página de cada encuesta.",
  keysNextMark: "Lo que viene",
  keysNextTitle: "Fideicomisarios independientes, antes de la primera votación cívica",
  keysNextLede:
    "El panel de lanzamiento está pensado para terminar. Hasta entonces, esta página lo dice en vez de mostrar fideicomisarios que aún no existen.",
  keysNext1Title: "El traspaso",
  keysNext1Body:
    "Los puestos pasan a fideicomisarios independientes y con nombre antes de que se celebre cualquier referendo cívico, cada paso un panel nuevo fijado en la cadena y en una nueva versión. Un traspaso protege solo las encuestas abiertas después: las abiertas antes siguen legibles con nuestras partes hasta que las destruyamos.",
  keysNext2Title: "Tus propios fideicomisarios",
  keysNext2Body:
    "Quien pregunta podrá añadir fideicomisarios propios a una encuesta. Sus respuestas se abrirán entonces solo con el panel de lanzamiento y los fideicomisarios de quien pregunta juntos, lo que protege esa encuesta de nosotros. El formulario de encuestas todavía no lo ofrece.",
  keysNext3Title: "Nombres y la ceremonia de llaves",
  keysNext3Body:
    "Cuando se nombren fideicomisarios independientes, esta página mostrará a cada uno, dónde está y el registro público de la ceremonia que creó sus llaves.",
  keysMore:
    "Lo demás que es débil, y cómo comprobar un conteo sin nosotros, se explica en las páginas de abajo.",
  keysMoreWeak: "Dónde es débil, dicho con claridad",
  dgTitle: "{section}: paso {step} de {total}",
  dgFake: "Para falsificar uno",
  dgFake0: "otra llave de acceso",
  dgFake1: "personas dispuestas a avalar en falso",
  dgFake2: "un documento oficial falsificado",
  dgPlanned: "Planeado",
  dgToday: "Hoy",
  dgResult: "Su propio resultado",
  dgNoTotal: "Sin fila de total.",
  dgDevice: "Tu dispositivo",
  dgLeaves: "Lo que sale de él",
  dgChoice: "Tu elección",
  dgCommitment: "Compromiso",
  dgShares: "Una parte por puesto",
  dgProofs: "Pruebas de validez",
  dgToBoard: "Al tablero público",
  dgToSeats: "Cada una a su puesto, cifrada",
  dgSealed: "Boleta sellada",
  dgCast: "Emitir",
  dgCheck: "Comprobar",
  dgOpened: "Abierta: elección y números aleatorios",
  dgRebuilt: "Reconstruida y comparada",
  dgNotCounted: "Nunca se cuenta",
  dgSealedAgain: "Sellada de nuevo, con números aleatorios nuevos",
  dgChecked: "Comprobada",
  dgEntry: "Entrada {index}",
  dgYours: "La tuya",
  dgReceipt: "Tu comprobante",
  dgReceiptEntry: "Entrada y tablero, firmados",
  dgInclusion: "Prueba de inclusión",
  dgStillThere: "Sigue en el tablero",
  dgAnchor: "Raíz anclada en Ethereum",
  dgSum: "Suma",
  dgTotal: "Total sellado por nivel",
  dgOurs: "Durante el lanzamiento, todos operados por Abolish",
  dgDomain: "abolish.us",
  dgServers: "Nuestros servidores",
  dgRegistry: "Registro de encuestas en capa 2",
  dgDirect: "Boletas enviadas directo a los contratos",
  dgMirrors: "IPFS, archivo y nodos comunitarios",
  dgAnchors: "Anclajes en Ethereum",
  dgVerifier: "El verificador",
  dgDown: "Fuera de línea",
  lookupLabel: "ID de la encuesta",
  lookupHint: "El ID de 64 caracteres de un enlace de encuesta o de un comprobante.",
  lookupSubmit: "Abrir encuesta",
  lookupInvalid: "Un ID de encuesta tiene 64 caracteres hexadecimales (0–9, a–f).",
  navModeration: "Registro de moderación",
  navPolls: "Encuestas",
  navDiscover: "Descubrir",
  discoverTitle: "Lo que la gente pregunta",
  discoverLede:
    "Preguntas abiertas de vecinos, grupos y escuelas. Nada aquí se ordena por clics, por discusiones ni por nada sobre ti: cada orden de abajo es igual para todos.",
  discoverTopicLede:
    "Preguntas abiertas que sus autores clasificaron en este tema. Nada aquí se ordena por clics, por discusiones ni por nada sobre ti.",
  discoverSorts: "Orden",
  discoverTopics: "Temas",
  topicAll: "Todos los temas",
  sort_new: "Nuevas",
  sort_closing: "Cierran pronto",
  sort_answered: "Más respondidas esta semana",
  sortNote_new: "Abiertas ahora, las más recientes primero.",
  sortNote_closing: "Abiertas ahora, las que cierran antes primero.",
  sortNote_answered:
    "Abiertas ahora, las más respondidas en los últimos siete días primero, cada persona contada una vez. Cada tarjeta cuenta todas las respuestas desde que abrió, así que puede mostrar más que la de arriba.",
  streamQuestions: "Preguntas",
  streamAnsweredSoFar: "Han respondido hasta ahora",
  streamAnsweredSinceDay: "Han respondido desde que abrió {day}",
  streamAnsweredSinceDate: "Han respondido desde que abrió el\u00a0{date}",
  streamAnsweredNone: "Nadie todavía",
  streamAnsweredUnread: "Ahora mismo no pudimos saber cuántos han respondido.",
  streamAnswered_email: {
    one: "{count} persona con correo verificado",
    other: "{count} personas con correo verificado",
  },
  streamAnswered_phone: {
    one: "{count} persona con correo y teléfono verificados",
    other: "{count} personas con correo y teléfono verificados",
  },
  streamAnswered_vouched: {
    one: "{count} persona avalada por otras personas",
    other: "{count} personas avaladas por otras personas",
  },
  streamAnswered_document: {
    one: "{count} persona verificada con pasaporte o documento de identidad",
    other: "{count} personas verificadas con pasaporte o documento de identidad",
  },
  streamCloses: "Cierra",
  streamPick: {
    one: "Elige una respuesta para abrirla en la app de votación. No se envía nada hasta que emitas tu boleta ahí.",
    other:
      "Elige una respuesta a la pregunta 1\u00a0de\u00a0{count} para abrirla en la app de votación. No se envía nada hasta que emitas tu boleta ahí.",
  },
  streamPickFirst: "Estas respuestas son para la pregunta 1\u00a0de\u00a0{count}.",
  streamNoBallot: "Responder desde esta página todavía no está disponible en este sitio.",
  streamUnreadable: "Esta encuesta no se puede mostrar aquí",
  streamUnreadableId: "Encuesta {prefix}…",
  streamText: "No pudimos leer su pregunta. Su propia página tiene todo lo que guardamos de ella.",
  streamUndecodable:
    "Sus datos llegaron dañados, así que aquí no se puede confiar en su pregunta ni en sus respuestas. Su propia página explica más.",
  streamMismatch:
    "Sus datos pertenecen a otra encuesta, así que aquí no se puede confiar en su pregunta ni en sus respuestas. Su propia página explica más.",
  streamEmpty: "No hay preguntas abiertas en este momento",
  streamEmptyLede: "Cuando alguien haga una, aparecerá aquí.",
  streamMore: "Más preguntas",
  streamSortUnavailableTitle: "Este orden no está disponible en este momento",
  streamSortUnavailable:
    "El servidor no puede contar las respuestas de esta semana en este momento.",
  streamSortUnavailableAction: "Ver las preguntas más nuevas",
  streamCursorLostTitle: "Esa página ya cambió",
  streamCursorLost:
    "La pregunta tras la que empezaba esta página ya no se puede ubicar en este orden.",
  streamStart: "Empezar desde arriba",
  streamLater: "Estas vienen después de la primera página.",
  streamEndTitle: "Esas eran todas",
  streamEnd: "Todas las preguntas abiertas en este orden estaban en las páginas anteriores.",
  streamSearchLabel: "Buscar en las preguntas",
  streamSearchHint:
    "Cada palabra que escribas debe aparecer en una pregunta o en su título, hasta {words} palabras. Los resultados mantienen el orden de abajo.",
  streamSearchSubmit: "Buscar",
  streamSearching: "Solo preguntas con todas tus palabras.",
  streamSearchClear: "Borrar la búsqueda",
  streamSearchEmpty: "Ninguna pregunta abierta coincide",
  streamSearchEmptyLede:
    "Prueba con menos palabras o más cortas: una pregunta coincide solo si las contiene todas.",
  streamSearchRefusedTitle: "No se puede hacer esa búsqueda",
  streamSearchRefused:
    "Una búsqueda tiene de una a {words} palabras, en {characters} caracteres como máximo.",
  listedUnder: "Dónde aparece",
  streamTagsNote:
    "Quienes preguntan eligen el tema y el lugar de su encuesta. No forman parte de la encuesta, y la moderación puede cambiarlos si no encajan.",
  streamNarrow: "Tema y lugar",
  streamPlaceSubmit: "Buscar",
  streamPlaceLabel: "Lugar",
  streamPlaceHint:
    "Un pueblo, barrio o escuela, tal como lo escriben quienes preguntan. No importan las mayúsculas ni los espacios, pero el nombre completo debe coincidir.",
  placeSuggested: "Sugiere los lugares en los que están clasificadas las encuestas de la lista.",
  streamPlaceFiltering: "Solo preguntas clasificadas en este lugar.",
  streamPlaceClear: "Borrar el lugar",
  streamTopicClear: "Ver todos los temas",
  streamFilterEmpty: "No hay preguntas abiertas clasificadas aquí",
  streamTopicEmptyLede: "Solo aparecen las preguntas clasificadas en este tema.",
  streamPlaceEmptyLede: "Solo aparecen las preguntas clasificadas en este lugar.",
  streamTopicPlaceEmptyLede:
    "Solo aparecen las preguntas clasificadas en este tema y en este lugar. Este tema puede tener más en otros lugares.",
  streamPlaceRefusedTitle: "No se puede buscar ese lugar",
  streamPlaceRefused:
    "Un lugar tiene de uno a {characters} caracteres, tal como lo escribiría quien pregunta.",
  listTitle: "Encuestas en la lista",
  listLede:
    "Encuestas que este servidor incluye en la lista, en orden de sus ID. Las encuestas que la moderación retiró de la lista u ocultó no aparecen, pero siguen abiertas por ID, y el registro de elecciones en cadena nombra todas las encuestas, sin importar lo que muestre esta lista.",
  listEmpty: "No hay encuestas en la lista.",
  listCloses: "Cierra",
  listIllFormed: "Incumple una regla del protocolo: el verificador la rechaza.",
  listMore: "Más encuestas",
  listUndecodable: "La definición del servidor no se puede decodificar.",
  listMismatch: "El servidor envió la definición de otra encuesta.",
  listOpens: "Abre",
  listCounted: "con recuento",
  listClosed: "Cerró",
  listPoll: "Encuesta",
  listCounting: "Conteo",
  listKind: "Tipo",
  listKindCounting: "Tipo y conteo",
  listStatus: "Estado",
  fingerprintPoll: "Huella de la encuesta {prefix}",
  status_open: "Abierta",
  status_scheduled: "Programada",
  status_closed: "Cerrada",
  registerEyebrow: "Registro de encuestas",
  registerTitle: "Todas las encuestas de la lista",
  registerCounts: "La lista en cifras",
  registerCountListed: "Encuestas de la lista",
  registerCountOpen: "Abiertas ahora",
  registerCountScheduled: "Programadas",
  registerCountAsOf: "Actualizado",
  registerLookupTitle: "Abrir una encuesta por su ID",
  registerFindTitle: "Buscar una encuesta",
  registerFindLede:
    "Busca entre todas las encuestas de la lista por sus palabras, su tema o su lugar, y luego filtra la página por estado y regla de conteo. Deja un grupo en Todas para incluirlo completo.",
  registerSearchLabel: "Buscar en las encuestas",
  registerSearchHint:
    "Cada palabra que escribas debe aparecer en el título o en las preguntas de una encuesta, hasta {words} palabras. Se buscan las encuestas abiertas, programadas y cerradas, en el orden de la lista.",
  registerSearching: "Solo las encuestas que contienen todas las palabras que buscaste.",
  registerSearchEmpty: "Ninguna encuesta de la lista coincide",
  registerSearchEmptyLede:
    "Prueba con menos palabras o más cortas: una encuesta coincide solo si su título o sus preguntas las contienen todas. Una encuesta que moderación retiró de la lista no se busca, pero se sigue abriendo por su ID.",
  registerTopicLabel: "Tema",
  registerFiledTopic: "Solo las encuestas clasificadas en {topic}.",
  registerFiledPlace: "Solo las encuestas clasificadas en el lugar que indicaste.",
  registerFiledEmptyLede:
    "Una encuesta está clasificada en un tema o un lugar solo si quien pregunta, o la moderación, la clasificó ahí, y un lugar coincide solo por su nombre completo. Una encuesta que moderación retiró de la lista no aparece, pero se sigue abriendo por su ID.",
  registerAsOf:
    "Los estados salen de las horas de apertura y cierre que declara cada encuesta, comparadas con el reloj de este servidor ({time} UTC).",
  filterAll: "Todas",
  filterApply: "Mostrar encuestas que coinciden",
  filterClear: "Borrar filtros",
  registerMatches: "{shown} de {total} encuestas de esta página coinciden.",
  registerPages: "Páginas de la lista",
  registerFirst: "Primera página",
  registerPrevious: "Página anterior",
  registerPastEnd: "No hay más encuestas",
  registerPastEndLede:
    "La lista termina antes de esta página. Va en orden de ID de encuesta, así que una encuesta añadida desde que empezó puede estar en una página anterior.",
  registerNoMatchTitle: "Ninguna encuesta de esta página coincide",
  registerNoMatch:
    "Nada en esta página de la lista coincide con estos filtros. Una encuesta que moderación retiró de la lista no aparece aquí, pero se sigue abriendo por su ID, y el registro de elecciones en la cadena todavía la nombra.",
  pollTitle: "Encuesta",
  pollHeading: "Encuesta {prefix}…",
  pollStatus_open: "Abierta a respuestas",
  pollStatus_scheduled: "Todavía no abre",
  pollStatus_closed: "Cerrada",
  pollAnswerTitle: "Cómo responder",
  pollAnswer:
    "Las respuestas se emiten solo en la app de votación, nunca en este sitio web, y cada una se sella en el propio dispositivo de quien vota antes de enviar nada.",
  pollAnswerOpen: { one: "Responder la pregunta", other: "Responder {count} preguntas" },
  pollAnswerScheduled: "Podrás responder aquí en cuanto abra la encuesta.",
  pollScheduledLede:
    "No se puede responder nada hasta que abra. Abajo se indica quién puede responder, cuándo y cómo se cuenta.",
  pollOpenLede: {
    one: "Una pregunta. Puedes cambiar tu respuesta hasta que cierre la encuesta, y solo cuenta la última.",
    other:
      "{count} preguntas, que se responden juntas. Puedes cambiar tus respuestas hasta que cierre la encuesta, y solo cuentan las últimas.",
  },
  pollFactsTitle: "Sobre esta encuesta",
  pollQuestionsTitle: "Lo que pregunta",
  pollQuestionsFixed:
    "La definición de la encuesta fija estas palabras, así que no se pueden editar antes de que abra ni mientras está abierta.",
  pollPickFrom: "{instruction} entre {options}",
  pollPickRule: "{instruction}. {pick}",
  pollFinal: {
    one: "Resultados finales. Respondió {count} persona; esto es lo que dijo.",
    other: "Resultados finales. Respondieron {count} personas; esto es lo que dijeron.",
  },
  pollInShort: "En resumen",
  pollAnsweredClosed: "Respondieron antes del cierre",
  pollAnswerClosed: "Esta encuesta ya cerró y no recibe más respuestas.",
  resultsTitle: "Resultados",
  resultsEachQuestion:
    "Cada pregunta se cuenta por separado. Las respuestas a distintas preguntas nunca se cruzan: solo se abren los totales de cada pregunta, así que ningún resultado muestra cómo respondió alguien el conjunto.",
  resultsSealed:
    "Las respuestas siguen selladas mientras la encuesta está abierta. Los resultados aparecen aquí una vez que se cuentan.",
  resultsSealedTitle: "Los resultados aparecen cuando cierre",
  resultsSealedUntil:
    "Las respuestas siguen selladas hasta que la encuesta cierre el {when}. Los resultados aparecen aquí una vez que se cuentan.",
  resultsSealedUntilClose:
    "Las respuestas siguen selladas hasta que la encuesta cierre. Los resultados aparecen aquí una vez que se cuentan.",
  resultsSealedAsker:
    "Hasta entonces, quien la preguntó tampoco puede verlas: solo los puestos de custodio de la encuesta pueden abrir el conteo, y durante el lanzamiento Abolish opera todos los puestos.",
  resultsSealedBoard:
    "Cualquiera puede contar las respuestas selladas en el tablero público de la encuesta; lo que dicen sigue bajo llave.",
  resultsCounting:
    "Esta encuesta ya cerró. Los resultados aparecen aquí una vez que se cuentan sus respuestas.",
  resultsNotCounted:
    "Este servidor no publica los resultados de esta encuesta. Cualquiera puede contarlos igual desde su tablero público.",
  resultsUnavailable:
    "No se pudieron cargar los resultados en este momento. Vuelve a intentarlo en un rato.",
  resultsAnswered: { one: "Respondió {count} persona", other: "Respondieron {count} personas" },
  resultsNoneAnswered: "Nadie respondió.",
  resultsTurnout: "Participación",
  resultsTierMeaning_email:
    "Cada cuenta de aquí demostró que tiene una dirección de correo. Quien tenga varias direcciones puede abrir varias cuentas, así que este grupo cuenta cuentas, no personas, y nunca se suma a otro.",
  resultsTierMeaning_phone:
    "Cada cuenta de aquí demostró que tiene una dirección de correo y un número de teléfono, y un número verifica una sola cuenta. Quien tenga varios números aún puede abrir varias cuentas, así que este grupo cuenta cuentas, no personas, y nunca se suma a otro.",
  resultsTierMeaning_vouched:
    "Por cada miembro respondieron personas ya verificadas, así que falsificar uno exige que otros respondan en falso.",
  resultsTierMeaning_document:
    "Cada miembro demostró en su propio teléfono, sin mostrarlo, que tiene un pasaporte o una identificación firmados por un gobierno, y el mismo documento no puede unirse dos veces. Quien tenga dos documentos aún puede unirse dos veces, así que este grupo cuenta documentos, no personas, y nunca se suma a otro.",
  resultsTurnoutOf: { one: "{share} de {count} miembro", other: "{share} de {count} miembros" },
  resultsTurnoutOfClose: {
    one: "{share} de {count} persona que podía responder antes del cierre",
    other: "{share} de {count} personas que podían responder antes del cierre",
  },
  resultsCouldAnswer: {
    one: "{count} persona podía responder antes del cierre",
    other: "{count} personas podían responder antes del cierre",
  },
  resultsFewCouldAnswer:
    "Podían responder tan pocas personas que estos resultados pueden mostrar cómo respondieron algunas.",
  resultsFewCouldAnswerShort: "Pocas personas podían responder",
  resultsTurnoutIs: "Participación: {turnout}",
  resultsTierPending:
    "Parte del conteo de este grupo todavía no se publica. Sus resultados aparecen aquí cuando se publique completo.",
  resultsLeader: "La más elegida: {option}, por el {share} de quienes respondieron.",
  resultsTied:
    "Empate como las más elegidas: {option}, cada una por el {share} de quienes respondieron.",
  resultsNothingPicked: "No se eligió ninguna respuesta.",
  resultsOption: "Respuesta {number}",
  resultsPeople: { one: "{count} persona", other: "{count} personas" },
  resultsClaim:
    "Estos son los resultados que nuestro servidor lee del conteo publicado en el tablero público de la encuesta. Nada en esta página los comprueba por ti: cualquiera puede volver a contar el tablero y comparar.",
  resultsCheck: "Comprobar el conteo en el tablero",
  resultsUpFront:
    "Todo lo de abajo es lo que nuestro servidor dice de esta encuesta. Cualquiera puede volver a contar su tablero sin nosotros y comparar.",
  resultsUpFrontLink: "Cómo comprobarlo tú",
  resultsSeeAll: "Ver todos los resultados",
  resultsPageTitle: "Resultados",
  resultsPageEyebrow: "Encuesta {prefix}… · Resultados",
  resultsPageLede:
    "Cada grupo se cuenta y se informa por separado, y cada pregunta también. Ninguna cifra de esta página suma dos grupos ni dos preguntas.",
  resultsByGroup: "Resultados por grupo",
  resultsSideBySide: "Los grupos uno al lado del otro",
  resultsSideBySideCaption:
    "Una columna por grupo. No hay columna de total: los grupos nunca se suman.",
  resultsAnswer: "Respuesta",
  resultsAnswers: "Respuestas",
  resultsNotAllPublished: "Aún no se publica todo",
  resultsCellsTitle: "Parte por parte",
  resultsCellsLede: {
    one: "Este grupo se cuenta en {count} parte.",
    other:
      "Este grupo se cuenta en {count} partes, cada una publicada por separado. Sus resultados de arriba son la suma de todas.",
  },
  resultsCell: "Parte",
  resultsCellName: "Parte {number}",
  resultsRegion: "región {number}",
  resultsCellMissing: "Aún no se publica",
  resultsCellFailed: "No pasó la comprobación del tablero",
  resultsCellsUnavailable: "Las partes de este grupo no se pudieron mostrar en este momento.",
  resultsOpeningsTitle: "Quién abrió el conteo",
  resultsOpeningsLede:
    "Cada parte del conteo la abre uno de los {size} puestos de custodio de esta encuesta, una vez que al menos {threshold} de ellos han aportado sus partes. El puesto que la abre firma la apertura, así que el tablero muestra cuál fue. Durante el lanzamiento, Abolish opera todos los puestos.",
  resultsOpeningsPart: "Parte del conteo",
  resultsOpenedBy: "Abierta por",
  resultsSeats: { one: "Puesto {seats}", other: "Puestos {seats}" },
  resultsOpenedUnsigned: "Ninguna firma de un puesto la valida",
  resultsStatusCounted: "Con recuento",
  resultsFingerprints:
    "Volver a contarla sin nosotros empieza por el ID de esta encuesta, y la definición que encuentre debe tener este hash, que fija las reglas de la encuesta antes de su primera respuesta.",
  resultsCheckTitle: "Compruébalo tú",
  resultsBoardTitle: "Lo que guarda el tablero",
  resultsBoardLede:
    "Los resultados de esta encuesta se cuentan a partir de su tablero público. Las entradas solo se agregan al final, y ninguna muestra cómo votó nadie.",
  resultsBoardUnavailable: "No se pudo leer el tablero en este momento.",
  resultsVerify: "Cómo contarlo tú",
  resultsReceiptTitle: "Tu comprobante",
  resultsReceiptBody:
    "Si respondiste, tu comprobante lo guarda la app de votación del dispositivo con el que respondiste. Muestra que tu boleta está en el tablero de esta encuesta, no cómo respondiste.",
  resultsReceiptCheck:
    "Esta página no busca comprobantes: pedirle a nuestro servidor tu entrada le diría cuál es la tuya. Para revisar el tuyo, copia el tablero completo, como explica Cómo contarlo tú, y busca tu entrada en tu copia.",
  resultsRecountTitle: "Cuenta esta encuesta de nuevo",
  resultsRecountBody:
    "Cuando el nodo comunitario haya copiado y verificado los tableros, como explica Cómo contarlo tú, el verificador revisa esta encuesta por separado con este comando. Su código de salida es el veredicto.",
  reactionsTitle: "Reacciones",
  reactionsLede:
    "Reacciona a la encuesta en sí. Una reacción no es una respuesta y no dice nada sobre si respondiste.",
  reactionsLabel: "Reacciones a esta encuesta",
  reaction_heart: "Corazón",
  reaction_laugh: "Risa",
  reaction_wow: "Asombro",
  reaction_thinking: "Pensativo",
  reaction_sad: "Triste",
  reaction_clap: "Aplauso",
  reactionCount: { one: "{name}: {count} persona", other: "{name}: {count} personas" },
  reactionsLoading: "Cargando reacciones…",
  reactionsPrivacy:
    "Cualquiera puede ver los conteos. Solo tú puedes ver cuáles reacciones son tuyas.",
  reactionsJoin: "Reacciona a esta encuesta",
  reactionsSignIn: "Iniciar sesión",
  reactionsSignedOut: "Para reaccionar necesitas iniciar sesión en una cuenta.",
  reactionsVerify: "Verifica tu correo",
  reactionsUnverified: "Para reaccionar necesitas un correo electrónico verificado.",
  reactionsHidden: "Esta encuesta está oculta, así que sus reacciones también.",
  reactionsTooManyThisHour:
    "Ya cambiaste tus reacciones todas las veces posibles en esta hora. Inténtalo más tarde.",
  reactionsFailed: "No se pudo completar. Inténtalo de nuevo en un momento.",
  reactionsUnread: "No se pudieron cargar las reacciones en este momento.",
  followTitle: "Seguir",
  followLede:
    "Recibe un correo cuando estén sus resultados. Seguirla no es responderla y no dice nada de si la respondiste.",
  followJoin: "Seguir esta encuesta",
  followStop: "Dejar de seguir",
  followFollowing: "Estás siguiendo esta encuesta.",
  followStopped: "Dejaste de seguir esta encuesta.",
  followPrivacy: "Solo tú puedes ver que la sigues. Nadie ve cuántas personas la siguen.",
  followSignIn: "Inicia sesión",
  followSignedOut: "Para seguirla necesitas una cuenta con la sesión iniciada.",
  followVerify: "Verifica tu correo",
  followUnverified: "Para seguirla necesitas un correo verificado, que es adonde te escribiríamos.",
  followHidden: "Esta encuesta está oculta, así que no se puede seguir.",
  followTooManyThisHour:
    "Ya seguiste y dejaste de seguir encuestas todas las veces que puedes en esta hora. Inténtalo más tarde.",
  followFailed: "No se pudo completar. Inténtalo de nuevo en un momento.",
  shareOpen: "Compartir esta encuesta",
  shareNeverYourAnswer:
    "Al compartir se envía este enlace, nunca tu respuesta. El enlace es el mismo para todos, así que no dice quién lo compartió ni si respondió.",
  shareLinkLabel: "Enlace a esta encuesta",
  shareCopy: "Copiar enlace",
  shareCopied: "Enlace copiado",
  shareCopiedStatus: "Enlace copiado. Pégalo donde quieras.",
  shareCopyFailed: "No se pudo copiar. Selecciona el enlace de arriba y cópialo.",
  shareMenu: "Compartir…",
  shareNoMenu:
    "Este navegador no tiene menú para compartir. Copia el enlace y pégalo donde quieras, o envíalo por correo.",
  shareEmail: "Enviar el enlace por correo",
  shareQrShow: "Mostrar un código QR",
  shareQrLabel: "Código QR de {link}",
  shareQrNote:
    "Apunta la cámara de un teléfono hacia él para abrir esta encuesta. Contiene el mismo enlace, así que no dice nada sobre quién lo mostró.",
  shareFlyer: "Imprimir un volante",
  shareEmbed: "Insertar en tu sitio",
  // The embed panel and the card (docs/design/sharing.md, Embed).
  embedTitle: "Insertar en tu sitio",
  embedDescription:
    "Pon esta encuesta en una página de noticias o en un sitio comunitario. La tarjeta nunca recibe respuestas: cada respuesta abre Abolish en una pestaña nueva.",
  embedKind: "Qué insertar",
  embedKindCard: "La tarjeta de la encuesta",
  embedKindCardNote:
    "Muestra la pregunta y sus respuestas. Se carga desde {host} sin scripts ni cookies.",
  embedKindLink: "Un enlace simple",
  embedKindLinkNote:
    "Solo la encuesta como enlace. No se carga nada desde {host} hasta que alguien hace clic.",
  embedTheme: "Colores",
  embedThemeAuto: "Según la configuración del lector",
  embedThemeLight: "Claro",
  embedThemeDark: "Oscuro",
  embedCode: "Código para pegar en tu página",
  embedCopy: "Copiar código",
  embedCopied: "Código copiado",
  embedCopyFailed: "No se pudo copiar. Selecciona el código de arriba y cópialo.",
  embedCardNote:
    "La tarjeta se carga desde {host} cada vez que alguien lee tu página, así que los navegadores de tus lectores contactan a {host}, sin cookies ni referente.",
  embedLinkNote: "El enlace no lleva nada sobre ti, tu sitio ni tus lectores.",
  embedLinkLine: "Responde en Abolish; cualquiera puede comprobar el conteo.",
  embedPreview: "Abrir la tarjeta en una pestaña nueva",
  embedBack: "Volver a compartir",
  embedNewTab: "(se abre en una pestaña nueva)",
  embedPick: {
    one: "Elige una. Tu elección abre Abolish en una pestaña nueva, donde la revisas y la envías.",
    other:
      "Elige una respuesta a la pregunta 1 de {count}. Se abre Abolish en una pestaña nueva, donde respondes las demás y las envías.",
  },
  embedAnswer: { one: "Responder en Abolish", other: "Responder {count} preguntas en Abolish" },
  embedSeePoll: "Ver la encuesta en {host}",
  embedCloses: "Cierra",
  embedClosed: "Cerrada",
  embedOpens: "Abre",
  embedNeverHere: "Las respuestas se reciben solo en Abolish, nunca en esta tarjeta.",
  embedHiddenTitle: "Esta encuesta está oculta",
  embedHidden: "Moderación ocultó el texto de esta encuesta, así que no se muestra aquí.",
  embedHiddenLink: "Ver el motivo en su página",
  embedNotFoundTitle: "No hay ninguna encuesta aquí",
  embedNotFound: "El enlace de esta tarjeta no nombra ninguna encuesta.",
  // A poll's link preview: the image a chat draws and the text beside it (src/og/).
  ogHeadlineCode: "Encuesta {code}",
  ogHeadlineHost: "Una encuesta en {host}",
  ogAskedBy: "Pregunta de {name}",
  ogAskedOn: "Pregunta hecha en {host}",
  ogCloses: "Cierra el {day}",
  ogClosed: "Cerrada el {day}",
  ogAnswersSoFar: { one: "{count} respuesta hasta ahora", other: "{count} respuestas hasta ahora" },
  ogAnswersCounted: { one: "{count} respuesta contada", other: "{count} respuestas contadas" },
  ogSealed: "Resultados cuando cierre",
  ogSealedOn: "Resultados cuando cierre el {day}",
  ogSealedNote: "Lo que responde la gente queda sellado hasta entonces.",
  ogSealedNoteCount: "{answers}. Lo que dicen queda sellado hasta entonces.",
  ogOpen: "Abierta",
  ogOpenUntil: "Abierta hasta el {day}",
  ogCheck: "Cualquiera puede comprobar el conteo.",
  ogCheckCount: "{answers}. Cualquiera puede comprobar el conteo.",
  ogCountingHead: "Cerrada",
  ogCountingHeadOn: "Cerrada el {day}",
  ogCountingNote: "El conteo aún no se ha publicado.",
  ogFinalCount: "Conteo final · {answers}",
  ogUpdated: "{answers} · actualizado el {day}",
  ogQuestionOne: "Pregunta 1 de {count}",
  ogMostPicked: "La más elegida",
  ogTiedPicked: "Empate como las más elegidas",
  ogQuestions: { one: "{count} pregunta", other: "{count} preguntas" },
  ogCivic: "Registro cívico · {kind}",
  ogTiers: "Cada nivel se cuenta por separado.",
  ogTiersReleased: "Publicado el {day}. Cada nivel se cuenta por separado.",
  ogTiersWill: "Cada nivel se contará por separado.",
  ogRecount: "Cualquiera puede volver a contarlo",
  ogWho: "Pregunta de {name}.",
  ogWhoIn: "Pregunta de {name} en {place}.",
  ogSoFar: "{answers}.",
  ogSealedText: "Los resultados quedan sellados hasta que cierre.",
  ogSealedTextOn: "Los resultados quedan sellados hasta que cierre el {day}.",
  ogOpenText: "Abierta hasta que cierre.",
  ogOpenTextOn: "Abierta hasta que cierre el {day}.",
  ogCountingText: "Cerrada; el conteo aún no se ha publicado.",
  ogCountingTextOn: "Cerrada el {day}; el conteo aún no se ha publicado.",
  ogClosedText: "Cerrada.",
  ogClosedTextOn: "Cerrada el {day}.",
  // The flyer (docs/design/sharing.md, Printable flyer).
  flyerTitle: "Imprimir un volante",
  flyerBack: "Volver a la encuesta",
  flyerIntro:
    "Para tableros de anuncios, vitrinas y reuniones. El código QR y el enlace son los mismos para todos, así que un volante no dice nada sobre quién lo colocó.",
  flyerPaper: "Papel",
  flyerPaperLetter: "Carta (EE. UU.)",
  flyerPaperA4: "A4",
  flyerInk: "Tinta",
  flyerInkColor: "Color",
  flyerInkMono: "Blanco y negro",
  flyerPrint: "Imprimir este volante",
  flyerPrintNote:
    "Imprime a tamaño real. Solo se imprime el volante, de borde a borde, así que desactiva los encabezados y pies de página si tu navegador los agrega.",
  flyerPreview: "El volante, tal como se imprime",
  flyerKicker: "Una encuesta en {host}",
  flyerQuestions: {
    one: "{count} pregunta breve.",
    other: "{count} preguntas breves, que se responden juntas.",
  },
  flyerScan: "Escanea para responder",
  flyerScanClosed: "Escanea para ver la encuesta",
  flyerOrType: "o escribe",
  flyerCloses: "Cierra {time}",
  flyerClosed: "Cerró {time}",
  flyerOpens: "Abre {opens}, cierra {closes}",
  flyerHowTitle: "Cómo responder",
  flyerHow:
    "Abre el enlace en un teléfono o una computadora y toca tu respuesta. Toma alrededor de un minuto, y puedes cambiarla hasta que la encuesta cierre.",
  flyerClosedTitle: "Esta encuesta ya cerró",
  flyerClosedBody: "Ya no recibe respuestas. Abre el enlace para ver cómo va el conteo.",
  flyerCheckTitle: "Cualquiera puede comprobar el conteo",
  flyerCheck:
    "Cada respuesta se sella y se publica en un tablero público, sin el nombre de quien la envió, y cualquiera puede volver a contar el resultado. Durante el lanzamiento, solo Abolish tiene la clave de esta encuesta.",
  flyerFoot: "No vinculante, hecha por ciudadanos.",
  flyerTabs: "Tiras desprendibles con el enlace",
  flyerHidden:
    "Moderación ocultó el texto de esta encuesta, así que no hay volante para ella. Su página explica el motivo.",
  // Why a poll couldn't be set up, one per failure code core writes
  // (@abolishus/core, POLL_FAILURES; ADR 0032, rule 14). A poll that can be
  // retried comes back as a draft; one whose election was registered stays.
  pollFailure_closesTooSoon:
    "La preparación tardó más de lo previsto, y tu encuesta habría cerrado muy poco después de abrir. Elige una hora de cierre más tarde y vuelve a enviarla.",
  pollFailure_creationReverted:
    "No se pudo crear tu encuesta en el registro público. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_creationReplaced:
    "Algo salió mal de nuestro lado mientras se creaba tu encuesta, así que nos detuvimos. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_creationTimeout:
    "Crear tu encuesta en el registro público tomó demasiado tiempo. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_creationAnchored:
    "Tu encuesta no pudo empezar limpiamente en el registro público tras tres intentos, así que sus respuestas no se podían proteger. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_tierUnavailable:
    "Todavía no se pueden preparar encuestas para los votantes que elegiste. Tu pregunta no se publicó. Cambia quién puede responder y vuelve a enviarla.",
  pollFailure_electorateEmpty:
    "Nadie habría podido responder: cuando se preparó tu encuesta, todavía no había nadie en el grupo de votantes que elegiste. Tu pregunta no se publicó. Puedes volver a enviarla más tarde o descartarla.",
  pollFailure_stubRefused:
    "Algo salió mal de nuestro lado mientras se preparaba tu encuesta. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_registrationRefused:
    "La preparación de tu encuesta no pasó nuestras comprobaciones, así que no la registramos. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_registrationReverted:
    "El registro público rechazó registrar tu encuesta. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_registrationReplaced:
    "Algo salió mal de nuestro lado mientras se registraba tu encuesta, así que nos detuvimos. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_registrationTimeout:
    "Registrar tu encuesta tomó demasiado tiempo. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_registrationMismatch:
    "Algo distinto de tu encuesta quedó registrado en su lugar del registro público, así que nos detuvimos antes de que abriera. Nunca recibirá respuestas y queda en el registro. Puedes volver a hacer tu pregunta en una encuesta nueva, a partir de lo que escribiste.",
  pollFailure_openMismatch:
    "Lo que el registro público tiene de tu encuesta no es exactamente lo que escribiste, así que no la abrimos. Nunca recibirá respuestas y queda en el registro. Puedes volver a hacer tu pregunta en una encuesta nueva, a partir de lo que escribiste.",
  pollFailure_ceremonyTimeout:
    "La clave que sella las respuestas de tu encuesta no se terminó de crear tras cuatro intentos. Tu pregunta no se publicó. Puedes volver a enviarla o descartarla.",
  pollFailure_openTimeout:
    "Tu encuesta se registró, pero no pudo abrir antes de su hora de cierre. Nunca recibirá respuestas y queda en el registro. Puedes volver a hacer tu pregunta en una encuesta nueva, a partir de lo que escribiste.",
  evidenceSummary: "¿Cómo sabemos que esto es real?",
  evidenceLede:
    "Cada respuesta se publica en el tablero público, que cualquiera puede descargar y volver a contar.",
  evidenceLedeClosed:
    "Cada respuesta se selló en el dispositivo que la envió y se publicó en el tablero público, que cualquiera puede descargar y volver a contar.",
  evidenceKey:
    "Quien la hizo no puede ver las respuestas de nadie. Durante el lanzamiento, solo Abolish tiene la clave de esta encuesta.",
  evidenceShow: "Mostrar la evidencia",
  evidenceHide: "Ocultar la evidencia",
  evidenceFingerprintTitle: "La huella de esta encuesta",
  evidenceFingerprint:
    "Se dibuja a partir del hash de la definición de la encuesta, que fija sus reglas antes de la primera respuesta. Una definición con cualquier cambio dibuja una forma distinta.",
  fingerprintDefinition: "Huella de la definición {prefix}",
  evidenceDefinitionTitle: "A qué se compromete la encuesta",
  pollId: "ID de la encuesta",
  pollClaim:
    "Todo lo que sigue es lo que nuestro servidor dice sobre esta encuesta. El verificador lo compara con la cadena; esta página no.",
  definitionHash: "Hash de la definición, para comparar con el registro de elecciones en la cadena",
  factType: "Conteo",
  factKind: "Tipo",
  class_everyday: "Encuesta cotidiana",
  class_organisational: "Votación de una organización",
  class_civic: "Referéndum cívico",
  pollCivicRecord:
    "Su definición la sitúa en el registro cívico, que solo admite encuestas cuya clave está en manos de custodios independientes. Todavía no se ha nombrado ninguno, así que el registro de elecciones en la cadena se niega a registrar una encuesta como esta.",
  typePlurality: "Una opción",
  typeApproval: "Aprobar las que quieras",
  typeQuestions: "Pregunta por pregunta",
  questionCount: { one: "{count} pregunta", other: "{count} preguntas" },
  factQuestions: "Preguntas",
  questionNumber: "Pregunta {number}",
  questionLimits: "{instruction}, de {options}; de {min} a {max} selecciones",
  instruction_one: "Elige una",
  instruction_any: "Elige las que quieras",
  instruction_upTo: "Elige hasta {max}",
  instruction_exactly: "Elige exactamente {count}",
  instruction_atLeast: "Elige al menos {min}",
  instruction_between: "Elige de {min} a {max}",
  factOptions: "Opciones",
  factSelections: "Selecciones por boleta",
  selectionsRange: "De {min} a {max}",
  optionCount: { one: "{count} opción", other: "{count} opciones" },
  factTrustees: "Custodios necesarios para descifrar el recuento",
  trusteesOf: "{threshold} de {size}",
  factOpens: "Abre",
  factCloses: "Cierra",
  factShortLink: "Enlace corto",
  factElectorate: "Quién puede votar",
  tier0: "Nivel 0 (llave de acceso)",
  tier0_email: "Nivel 0 (correo verificado)",
  tier0_phone: "Nivel 0 (correo y teléfono verificados)",
  tier1: "Nivel 1 (con aval)",
  tier2: "Nivel 2 (documento verificado)",
  groupMembers: { one: "{count} miembro", other: "{count} miembros" },
  groupMembersAtOpening: {
    one: "{count} miembro al abrirse",
    other: "{count} miembros al abrirse",
  },
  rollingTier0: "Abierta a nuevas identidades hasta que cierre",
  rollingTier: "Abierta a nuevos miembros hasta que cierre",
  boardTitle: "Tablero público",
  boardEntries: "Entradas",
  boardEmpty: "Todavía no hay entradas.",
  boardHead: "Cabeza de la cadena",
  boardHeadMeaning: {
    one: "La cabeza de la cadena es el enlace de la última entrada, y cada enlace incluye en su hash el anterior, así que la cabeza compromete todas las entradas en orden. Dos copias de este tablero con la misma cabeza contienen la misma única entrada.",
    other:
      "La cabeza de la cadena es el enlace de la última entrada, y cada enlace incluye en su hash el anterior, así que la cabeza compromete todas las entradas en orden. Dos copias de este tablero con la misma cabeza contienen las mismas {count} entradas.",
  },
  boardRoot: "Raíz del árbol",
  boardUnanchored:
    "Hasta que un punto de control en L1 cubra estos valores, solo cuentan con la palabra de este servidor. Guárdalos: un tablero posterior que no los extienda es evidencia de manipulación.",
  boardHeadHistory:
    "La raíz del árbol de arriba y la del punto de control más reciente son una sola historia: esta página comprobó que el árbol menor es el comienzo del mayor, con la prueba de consistencia de nuestro servidor, o con la misma raíz al mismo tamaño.",
  boardHeadHistoryBroken:
    "La raíz del árbol de arriba y la del punto de control más reciente no son una sola historia: nuestro servidor no pudo probar que el árbol menor es el comienzo del mayor. Guarda ambas. Un tablero con dos historias es evidencia de manipulación.",
  boardLink: "Leer el tablero, entrada por entrada",
  boardPageEyebrow: "Encuesta {prefix}… · Tablero público",
  boardPageTitle: "El tablero de la encuesta",
  boardPageLede:
    "Cada registro del tablero de esta encuesta, en el orden en que el tablero los recibió: la ceremonia de claves, los eventos de la cadena, las boletas selladas, las aperturas y el conteo. Las entradas solo se agregan al final, y ninguna muestra cómo votó nadie.",
  boardPageBack: "Volver a la encuesta",
  boardPageScope: "en este tablero al cargar esta página",
  boardPageClaim:
    "Estas entradas vienen de nuestro servidor. Esta página decodifica cada una, comprueba que nombra esta encuesta y que está en su lugar, y calcula su hash por su cuenta. Si cada entrada se encadena hasta la cabeza de arriba lo determina el verificador, que revisa el tablero completo.",
  boardLedgerMark: "El libro de registro",
  boardLedgerTitle: "Leer el tablero, entrada por entrada",
  boardLedgerLede:
    "Cada fila es una entrada: su número, el periodo de anclaje en que el tablero la agregó, lo que registra y su hash. La huella dibuja el hash, así que se pueden comparar dos copias sin leer hexadecimal.",
  boardColumnEntry: "Entrada",
  boardColumnPeriod: "Periodo",
  boardColumnKind: "Tipo",
  boardColumnHash: "Hash de la entrada",
  boardCaption: "Entradas {first} a {last} de {count}",
  boardEnd: "Aquí termina el tablero. Las entradas posteriores aparecerán aquí.",
  boardBeyond:
    "El tablero tiene {count} entradas, numeradas desde 0, así que todavía no existe la entrada {entry}.",
  boardKindLegend: "Tipo",
  boardKindApply: "Mostrar entradas de este tipo",
  boardKindMatches: "{shown} de las {total} entradas de esta página son de este tipo.",
  boardKindNone:
    "Ninguna entrada de esta página es de este tipo. Las páginas anteriores o posteriores pueden tener algunas.",
  boardPages: "Páginas del tablero",
  boardEarlier: "Entradas anteriores",
  boardLater: "Entradas posteriores",
  boardLatest: "Entradas más recientes",
  boardInTree: {
    one: "La {count} entrada de esta página que cubre la raíz del árbol de arriba está en ese árbol: esta página comprobó la prueba de inclusión de nuestro servidor para ella contra la raíz.",
    other:
      "Las {count} entradas de esta página que cubre la raíz del árbol de arriba están cada una en ese árbol: esta página comprobó la prueba de inclusión de nuestro servidor para cada una contra la raíz.",
  },
  boardOutsideTree:
    "La entrada {entry} no está en el árbol cuya raíz aparece arriba: nuestro servidor no pudo probar que lo está. Guarda esta página. Una entrada mostrada fuera del tablero con el que se compromete su raíz es evidencia de manipulación.",
  boardOwnEntry:
    "Esta página no busca la entrada de un comprobante: pedirle a nuestro servidor tu propia entrada le diría cuál es la tuya, y cada página aquí abarca 25 entradas para que navegar le revele menos. Para revisar tu comprobante, descarga el tablero completo y busca tu entrada ahí, donde nadie se entera de cuál buscaste.",
  boardEntriesUndecodable:
    "Nuestro servidor envió entradas del tablero de esta encuesta que no pasan la comprobación: una no se decodifica según la definición de la encuesta, nombra otra encuesta o está en otro lugar. Esta página no muestra ninguna en vez de mostrar un tablero que no puede leer. Su tablero no se ve afectado en ningún otro lugar donde esté copiado.",
  fingerprintHead: "Huella de la cabeza de la cadena {prefix}",
  fingerprintEntry: "Huella de la entrada {entry}",
  boardActivityMark: "Actividad",
  boardActivityTitle: "Entradas por período",
  boardActivityLede:
    "Cuántas entradas agregó el tablero en cada uno de sus períodos de anclaje más recientes, de una hora cada uno, calculadas con los puntos de control de abajo: cada cuenta es cuántas entradas más tiene el punto de control de un período que el anterior. Un período sin punto de control no agregó nada.",
  boardActivityClaim:
    "Estas cuentas se calculan aquí a partir de los puntos de control de nuestro servidor, así que valen lo que valen ellos. El verificador cuenta cada período a partir del tablero y sus anclajes.",
  boardActivityChart:
    "Entradas por período, del período {first} al {last}: {total} entradas en total. Cada período está en la tabla de abajo.",
  boardActivityPeriod: "Período {segment}",
  boardActivityMost: "Lo más en un período: {count}",
  boardActivityTable: "La cuenta de cada período",
  boardActivityCaption: "Entradas agregadas en cada período, el más antiguo primero",
  boardActivityColumnPeriod: "Período",
  boardActivityColumnAdded: "Entradas agregadas",
  boardActivityNone:
    "Todavía no se pueden contar las entradas de ningún período: hace falta un punto de control, y el anterior o el primero del tablero.",
  boardActivityUndecodable:
    "Sin puntos de control que pasen la comprobación, esta página no puede contar las entradas del tablero por período.",
  boardAnchorsMark: "Anclajes",
  boardAnchorsTitle: "Puntos de control para Ethereum",
  boardAnchorsLede:
    "Después de cada hora que agregó entradas, nuestro servidor toma un punto de control del tablero: cuántas entradas tiene, la cabeza de su cadena y su raíz de Merkle al final de esa hora. El anclaje pone su hash en el contrato de anclaje en Ethereum, y desde entonces una entrada alterada ya no coincide con él. Un punto de control se toma antes de anclarse, y hasta que el anclaje lo tenga, solo cuenta con nuestra palabra.",
  boardAnchorsClaim:
    "Estos puntos de control vienen de nuestro servidor. Esta página decodifica cada uno, comprueba que nombra esta encuesta y que cada uno anterior no tiene más entradas, y calcula su hash por su cuenta. También comprueba las pruebas de consistencia de nuestro servidor de que cada punto de control mostrado extiende el anterior. No comprueba que ninguno esté anclado ni que coincida con las entradas: eso lo determina el verificador, que lee el anclaje y el tablero entero por su cuenta.",
  boardAnchorsList: "Puntos de control, el más reciente primero",
  boardAnchorPeriod: "Después del período {segment}",
  boardAnchorLatest: "El más reciente",
  boardAnchorSize: "Entradas hasta entonces",
  boardAnchorHash: "Hash del punto de control, el valor por anclar",
  boardAnchorHead: "Cabeza de la cadena hasta entonces",
  boardAnchorRoot: "Raíz de Merkle hasta entonces",
  boardAnchorExtends:
    "Extiende el punto de control después del período {segment}: esta página lo comprobó, con la prueba de consistencia de nuestro servidor entre los dos, o con la misma raíz al mismo tamaño.",
  boardAnchorBroken:
    "No extiende el punto de control después del período {segment}: nuestro servidor no pudo probar que lo extiende. Guarda ambos. Un tablero con dos historias es evidencia de manipulación.",
  boardAnchorsNone: "Todavía no se ha tomado ningún punto de control de este tablero.",
  boardAnchorsMore:
    "Aquí solo se muestran los {count} puntos de control más recientes. El verificador lee cada uno de los anclados, desde el primero.",
  boardAnchorsUndecodable:
    "Nuestro servidor envió puntos de control de este tablero que no pasan la comprobación: uno no se decodifica, nombra otra encuesta o tiene más entradas que uno posterior. Esta página no muestra ninguno en vez de mostrar puntos de control que no puede leer.",
  boardCeremonyMark: "Ceremonia de claves",
  boardCeremonyTitle: "Cómo se hizo la clave de la encuesta",
  boardCeremonyLede:
    "Antes de que una encuesta abra, sus puestos de custodio hacen la clave con la que se sellan sus respuestas, en cuatro rondas de mensajes firmados: sus claves, desafíos, respuestas y revelaciones. El registro de las cuatro es la primera entrada del tablero, y la definición de la encuesta se compromete con su hash.",
  boardCeremonyClaim:
    "Esta página decodifica ese registro, calcula su hash ella misma y lo compara con el de la definición, y lee qué puestos enviaron un mensaje en cada ronda. No comprueba las pruebas que contiene, ni por tanto qué puestos calificaron: eso le corresponde al verificador, que comprueba el registro contra el panel de custodios que nombra nuestra versión.",
  boardCeremonyCommitted:
    "Este es el registro con el que se compromete la definición de la encuesta: esta página calculó su hash y encontró el de la definición.",
  boardCeremonyNotCommitted:
    "Este no es el registro con el que se compromete la definición de la encuesta: su hash, calculado aquí, no es el de la definición. Guarde esta página. Un tablero cuya ceremonia no coincide con su encuesta no pasa el verificador.",
  boardCeremonyHash: "Hash del registro de la ceremonia, calculado aquí",
  fingerprintCeremony: "Huella del registro de la ceremonia de claves",
  boardCeremonySeatsTitle: "Puestos que enviaron las cuatro rondas: {count} de {seats}",
  boardCeremonySeats: "Puestos de custodio, en orden",
  boardCeremonySeat: "Puesto {index}",
  boardCeremonyAllRounds: "Las cuatro rondas",
  boardCeremonySomeRounds: "{count} de las cuatro rondas",
  boardCeremonyLaunch: "Durante el lanzamiento, Abolish opera todos los puestos.",
  boardCeremonyMissing:
    "La primera entrada del tablero no es un registro de ceremonia. El tablero de una encuesta debe empezar con uno, así que el verificador rechaza esta encuesta.",
  boardCeremonyUndecodable:
    "La primera entrada del tablero no se decodifica como un registro de ceremonia que esta página lea, en la versión que fija la definición de la encuesta.",
  boardCeremonyEmpty:
    "El tablero aún no tiene entradas, así que el registro de la ceremonia no está en él.",
  boardCeremonyElsewhere: "El registro de la ceremonia es la primera entrada del tablero.",
  boardCeremonyFirstPage: "Verlo en la primera página",
  fingerprintCheckpoint: "Huella del punto de control después del período {segment}",
  entryKind_ballot: "Boleta sellada",
  entryKind_spoiledOpening: "Boleta anulada, abierta",
  entryKind_ceremony: "Ceremonia de claves",
  entryKind_tallyOpening: "Conteo, abierto",
  entryKind_contractEvent: "Evento de la cadena",
  entryKind_shareReceipt: "Comprobante de custodio",
  entryKind_shareComplaint: "Queja de custodio",
  entryKind_destruction: "Clave destruida",
  entryKind_closeStatement: "Declaración de cierre",
  entryKind_runningOpening: "Conteo parcial, abierto",
  entryKind_authorApprovals: "Aprobación de los custodios del autor",
  illFormed:
    "Esta definición rompe una regla del protocolo ({rule}), así que el verificador rechaza esta elección.",
  illFormedQuestion:
    "Esta definición rompe una regla del protocolo ({rule}) en la pregunta {number}, así que el verificador rechaza esta elección.",
  "rule_protocol-major": "versión de protocolo no compatible",
  "rule_profile-order": "versiones de registro fuera de orden",
  "rule_profile-types": "tipos de registro incorrectos",
  "rule_profile-version": "un registro en la versión 0",
  "rule_option-count": "número de opciones",
  rule_selections: "límites de selección",
  rule_questions: "sin preguntas",
  rule_electorate: "quién puede votar",
  rule_cells: "grupos de resultados",
  rule_panel: "panel de custodios",
  rule_chain: "cadenas y contratos",
  rule_timing: "horas de apertura y cierre",
  "rule_receipt-keys": "claves de comprobante",
  rule_results: "calendario de resultados",
  "rule_civic-sealed": "resultados cívicos sellados",
  "rule_author-panel": "custodios de quien pregunta",
  "rule_rolling-class": "quién puede unirse a una encuesta cívica",
  "rule_rolling-tier": "grupos que pueden unirse",
  utcTime: "{time}\u00a0UTC",
  zonedTime: "{time}\u00a0{zone}",
  zonedDayTime: "{day}, {time}\u00a0{zone}",
  shortId: "{prefix}…",
  moderationDelisted:
    "Esta encuesta queda fuera de Descubrir y de la búsqueda ({reason}). Su tablero y su resultado no se ven afectados.",
  moderationHidden:
    "El texto de la pregunta y de las opciones de esta encuesta está retenido ({reason}). Su tablero y su resultado no se ven afectados y se muestran por número de opción.",
  moderationLogLink: "Ver el registro de moderación",
  siteTagline: "Pregunta lo que sea. Comprueba todo.",
  skipToContent: "Saltar al contenido",
  navSite: "Sitio",
  navHome: "Inicio",
  navDiscoverNote: "Busca las preguntas que la gente está haciendo",
  navPollsNote: "Todas las encuestas de este sitio",
  navModerationNote: "Por qué se ocultó una encuesta o se dejó fuera de la búsqueda",
  navHomeNote: "Vuelve a empezar desde la portada",
  footerClaim: "No vinculante, a cargo de la ciudadanía, y cada conteo se puede comprobar.",
  footerRecord:
    "Cada encuesta aquí está en un tablero público que cualquiera puede descargar y volver a contar.",
  footerNav: "El registro",
  otherPlaces: "Otros lugares a donde ir",
  notFoundCode: "404 · No encontrada",
  notFoundPageTitle: "Página no encontrada",
  notFoundTitle: "No hay ninguna página en esta dirección",
  notFound:
    "Puede que el enlace esté mal escrito o incompleto. Las encuestas y sus resultados nunca se borran, así que el enlace propio de una encuesta sigue funcionando.",
  notFoundPoll:
    "¿Buscas una encuesta que alguien compartió? Pídele que te vuelva a enviar el enlace, o búscala abajo.",
  unavailableTitle: "Encuesta no disponible",
  definitionUndecodable:
    "El servidor envió una definición que no se decodifica según el protocolo, así que esta página no la mostrará.",
  definitionMismatch:
    "El servidor envió la definición de otra encuesta para este ID, así que esta página no la mostrará.",
  errorTitle: "Algo salió mal de nuestro lado",
  errorPageTitle: "Algo salió mal",
  error:
    "No se pudo mostrar esta página. Inténtalo de nuevo en un momento, o ve a otro lugar abajo.",
  errorBallot:
    "Este sitio web nunca maneja boletas: si estabas votando, tu boleta y tu comprobante están a salvo en la app de votación de tu dispositivo.",
  errorRetry: "Intentar de nuevo",
  offlineTitle: "No tienes conexión",
  offline:
    "Este dispositivo no puede conectarse a Abolish en este momento, así que la página que abriste no pudo cargar. Se abrirá como de costumbre cuando vuelvas a tener conexión.",
  offlineKept:
    "Para momentos así, tu dispositivo guarda solo esta página y sus fuentes. No se guarda ninguna página de encuesta ni de cuenta que hayas abierto.",
  offlineRetry: "Intentar de nuevo",
  moderationEyebrow: "Moderación · Pública y solo de anexado",
  moderationTitle:
    "La moderación actúa sobre el texto de las encuestas, nunca sobre los resultados",
  moderationLede:
    "Cada decisión que tomamos sobre una encuesta o el perfil de un creador es una fila de este registro, en el orden en que la tomamos. Solo se agregan filas: una decisión se revierte con otra posterior, que queda junto a ella. El registro no nombra al moderador, a quien denunció ni la cuenta de nadie: un perfil aparece solo como su identificador público.",
  moderationReach: "Hasta dónde llega la moderación",
  moderationActsOn: "Actúa sobre",
  moderationActsOn_text: "La pregunta, las opciones y la descripción de una encuesta",
  moderationActsOn_listing: "Si nuestras páginas listan la encuesta, y bajo qué tema y lugar",
  moderationActsOn_profile: "El perfil de un creador: su nombre y las encuestas que muestra",
  moderationNeverActsOn: "Nunca actúa sobre",
  moderationNeverActsOn_board: "Las boletas y el tablero",
  moderationNeverActsOn_definition:
    "La definición, el electorado o la hora de cierre de una encuesta",
  moderationNeverActsOn_result: "El conteo y el resultado",
  moderationResultsStay:
    "Muestren lo que muestren nuestras páginas, el tablero de cada encuesta sigue siendo público, y cualquiera que lo descargue puede volver a contarlo.",
  moderationLogMark: "El registro",
  moderationLogTitle: "Decisiones, de la más reciente a la más antigua",
  moderationLogLede:
    "Las horas son las del reloj de la base de datos, en UTC, no las del moderador. Una fila contiene solo la encuesta o el perfil, la acción y su motivo, nunca texto libre, así que ni siquiera el nombre de un perfil o el lugar de una encuesta: una reclasificación solo dice si cambió o quitó el lugar. Nuestra API ofrece el mismo registro para que cualquiera lo copie:",
  moderationEmpty: "Aún no hay decisiones.",
  moderationSeq: "N.º",
  moderationPoll: "Encuesta",
  moderationProfile: "Perfil",
  moderationSubject: "Encuesta o perfil",
  moderationAction: "Acción",
  moderationReason: "Motivo",
  moderationDecided: "Hora",
  moderationMore: "Decisiones anteriores",
  moderationLatest: "Decisiones más recientes",
  moderationLater: "Decisiones posteriores",
  moderationActionApply: "Mostrar estas decisiones",
  moderationActionMatches: "{shown} de las {total} decisiones de esta página tomaron esta acción.",
  moderationActionNone: "Ninguna decisión de esta página tomó esta acción.",
  moderationActionEarlier: "Las decisiones anteriores pueden tener alguna.",
  moderationCounts: {
    one: "Todo el registro desde el {since}: {count} decisión, por acción",
    other: "Todo el registro desde el {since}: {count} decisiones, por acción",
  },
  moderationCountsShown: "Se muestra abajo",
  moderationPageOfLog: {
    one: "Esta página contiene {shown} de {count} decisión del registro.",
    other: "Esta página contiene {shown} de las {count} decisiones del registro.",
  },
  moderationGroundsMark: "Motivos",
  moderationGroundsTitle: "Los únicos siete motivos",
  moderationGroundsLede:
    "Cada retiro cita exactamente uno. Usamos la acción menos restrictiva: una encuesta se retira de la lista, a menos que mostrar su texto cause daño por sí mismo.",
  ground_illegal:
    "Contenido cuyo alojamiento o distribución es ilegal donde operamos, como material de abuso sexual infantil.",
  "ground_personal-data":
    "Datos personales de un particular: un domicilio, un número de teléfono, un número de identificación, datos de salud o financieros, o cualquier cosa que identifique a un votante.",
  ground_threat:
    "Una amenaza creíble de violencia, o la incitación a la violencia contra una persona o un grupo.",
  ground_harassment: "Texto que ataca a un particular para hostigarlo.",
  ground_spam: "Encuestas masivas o automatizadas, estafas, phishing o enlaces a malware.",
  ground_impersonation:
    "Una encuesta presentada como si viniera de una persona, organización o autoridad que no la creó.",
  "ground_legal-notice": "Un aviso u orden que la ley nos obliga a atender.",
  moderationNeverTitle: "Nunca son motivo, sea cual sea la presión",
  moderationNever_viewpoint: "El punto de vista político o religioso de una encuesta",
  moderationNever_controversy: "Que su tema sea polémico",
  moderationNever_criticism:
    "Las críticas a cualquier persona, gobierno u organización, incluidos nosotros",
  moderationNever_publicFigure: "Que una figura pública objete una encuesta sobre su papel público",
  moderationNever_reports: "Que una encuesta sea impopular o reciba muchas denuncias",
  moderationNever_result: "El resultado o la participación de la encuesta, reales o previstos",
  moderationRestoreTitle: "Motivos para restaurar una encuesta",
  "ground_appeal-upheld": "El creador de la encuesta apeló, y la apelación prosperó.",
  ground_error: "El retiro fue un error evidente.",
  "ground_notice-withdrawn": "El aviso legal que lo motivó fue retirado o anulado.",
  moderationAppealOnce:
    "Quien creó una encuesta puede apelar una vez, desde su cuenta, la decisión de quitarla de la lista u ocultarla, o de ocultar su perfil. La revisa un moderador distinto del que decidió.",
  moderationReportsMark: "Denuncias",
  moderationReportsTitle: "¿Ves una encuesta que incumple estas reglas?",
  moderationReportsLede:
    "Cualquiera puede denunciar una encuesta o el perfil de quien la creó, sin cuenta, desde su propia página: elige el motivo que corresponde y envíala. Las denuncias se cuentan, nunca quién las envió, y un moderador juzga lo denunciado según los motivos de arriba: el número de denuncias nunca decide nada.",
  moderationReportsFind: "Buscar la encuesta en el registro",
  action_delist: "Retirada de la lista",
  action_hide: "Texto oculto",
  action_restore: "Restaurada",
  profileAction_hide: "Perfil oculto",
  action_refile: "Reclasificada",
  refiledTopic: "Tema ahora: {topic}",
  refiledTopicCleared: "Sin tema",
  refiledPlaceChanged: "Lugar cambiado",
  refiledPlaceCleared: "Sin lugar",
  reason_misfiled: "Mal clasificada",
  reason_illegal: "Contenido ilegal",
  "reason_personal-data": "Datos personales",
  reason_threat: "Amenaza",
  reason_harassment: "Hostigamiento",
  reason_spam: "Spam",
  reason_impersonation: "Suplantación",
  "reason_legal-notice": "Aviso legal",
  "reason_appeal-upheld": "Apelación aceptada",
  reason_error: "Error del moderador",
  "reason_notice-withdrawn": "Aviso retirado",
  navAccount: "Cuenta",
  accountEyebrow: "Cuenta",
  accountTitle: "Inicia sesión o crea una cuenta",
  accountLede:
    "Una cuenta te permite crear y administrar encuestas. No la necesitas para votar, y nunca emite un voto: las boletas se emiten en la app de votación, y nada de lo que hay aquí puede saber cómo votaste ni si votaste.",
  accountTitleAsk: "Inicia sesión para hacer tu pregunta",
  accountLedeAsk:
    "Una pregunta se hace desde una cuenta, que la guarda como borrador hasta que la publiques y te permite volver a ella. Inicia sesión, o crea una cuenta con una llave de acceso, y a continuación se abre el formulario de la pregunta.",
  accountEyebrowSignedIn: "Cuenta · Sesión iniciada con una llave de acceso",
  accountTitleSignedIn: "Tu cuenta",
  accountLedeSignedIn:
    "Las llaves de acceso con las que inicias sesión en este sitio web. Tus votos no están aquí: viven en la app de votación de tu dispositivo.",
  accountNeedsScript: "Las cuentas usan llaves de acceso, que necesitan el script de esta página.",
  accountHaveOne: "Tengo una cuenta",
  accountHaveOneLede:
    "Tu dispositivo te pedirá tu huella digital, tu rostro o el bloqueo de pantalla. No hay contraseña.",
  accountNew: "Soy nuevo aquí",
  accountNewLede:
    "Creamos una llave de acceso en este dispositivo y guardamos solo su clave pública. No hace falta un nombre. Luego verificas una dirección de correo electrónico, que se necesita para votar: una cuenta por dirección.",
  accountSignUp: "Crear cuenta con llave de acceso",
  accountSignIn: "Iniciar sesión con una llave de acceso",
  accountSignOut: "Cerrar sesión",
  accountSignOutOthers: "Cerrar sesión en todos los demás lugares",
  signedIn: "Iniciaste sesión.",
  signedOut: "Cerraste sesión.",
  accountDeleted: "La cuenta se eliminó.",
  passkeyRemoved: "Llave de acceso eliminada.",
  signedOutOthers: "Se cerraron todas las demás sesiones de esta cuenta.",
  separationMark: "Cuentas y votos",
  separationTitle: "Tu cuenta no es tu voto",
  separationLede:
    "Las dos se mantienen separadas por diseño. Ninguna tabla ni registro de nuestros servidores vincula una cuenta con una boleta, y las rutas de las boletas rechazan cualquier solicitud que lleve la cookie de una cuenta. Las pruebas verifican ambas cosas en cada cambio.",
  separationServer: "En nuestros servidores",
  separationAccount: "Tu cuenta",
  separationAccount_passkeys: "La clave pública de cada llave de acceso, y cuándo se agregó",
  separationAccount_sessions: "Tus inicios de sesión en este sitio web",
  separationAccount_email: "Tu dirección de correo electrónico, cifrada",
  separationAccount_phone: "Una huella con clave de tu número de teléfono, nunca el número",
  separationAccountNote:
    "Quién eres para este sitio web. Puede crear y administrar encuestas. No puede votar.",
  separationNeverJoined: "Nunca se vinculan",
  separationDevice: "En tu dispositivo",
  separationIdentity: "Tu identidad de votación",
  separationIdentity_secret: "Un secreto que prueba que puedes votar, sin decir quién eres",
  separationIdentity_receipts: "Los comprobantes de tus boletas",
  separationIdentityNote:
    "Nunca sale de tu dispositivo sin cifrar. Si guardas una copia de seguridad, nuestro servidor la almacena sellada con la propia llave de acceso de la identidad, y no puede abrirla.",
  passkeysTitle: "Llaves de acceso",
  passkeysHeading: "Cómo inicias sesión",
  passkeysLede:
    "Cualquiera de estas inicia sesión en esta cuenta. Tu identidad de votación tiene su propia llave de acceso, que no aparece aquí: nunca la vemos.",
  passkeySynced: "Llave de acceso sincronizada",
  passkeySyncedHelp:
    "Tu proveedor de llaves de acceso la mantiene sincronizada en tus dispositivos",
  passkeyDevice: "Llave de acceso del dispositivo",
  passkeyDeviceHelp: "Solo en un dispositivo o llave de seguridad",
  passkeyAddedAt: "Agregada el {created} UTC",
  passkeyRemove: "Eliminar",
  passkeyRemoveWhich: "la llave de acceso agregada el {created} UTC",
  passkeyLast: "Tu última llave de acceso",
  passkeyAdd: "Agregar una llave de acceso",
  passkeyAdded: "Llave de acceso agregada.",
  noticesMark: "Notificaciones",
  noticesTitle: "Sobre qué te avisamos",
  noticesLede:
    "Por correo electrónico, a la dirección que verificaste arriba. Sin una, no se envía nada, y lo que te avisaríamos sigue estando aquí, en esta página.",
  noticesModeration:
    "Una decisión de moderación sobre una de tus encuestas, tu perfil o tu apelación",
  noticesModerationHelp:
    "Siempre se envía, para que puedas apelar. No se puede desactivar. Llega en el idioma en que verificaste tu dirección.",
  noticesWhen:
    "Cada uno llega al día siguiente, como mucho un correo al día, y solo dice que hay una decisión o resultados que ver. Qué se decidió, y por qué, está aquí, en esta página, y en el registro público de moderación, y qué encuesta tiene sus resultados está en tu lista de abajo: dejamos ambas cosas fuera del correo para que el servicio que lo entrega sepa lo menos posible.",
  noticesResults: "Resultados de una encuesta que sigues",
  noticesResultsHelp:
    "Activado a menos que lo desactives. Desactivado, la encuesta igual pasa a tu lista de abajo cuando tiene sus resultados; solo se deja fuera el correo. Es lo mismo en todos los dispositivos en que inicias sesión.",
  noticesResultsOn: "Te enviaremos un correo cuando una encuesta que sigues tenga sus resultados.",
  noticesResultsOff: "No te enviaremos correos sobre resultados.",
  pushLabel: "Avisar también a este navegador",
  pushHelp:
    "Una notificación en este dispositivo cuando sale el correo, que dice solo que hay algo que ver aquí. La entrega la empresa que hace tu navegador, así que sabe que usas Abolish y el día en que se envió.",
  pushOn: "Se avisará a este navegador.",
  pushOff: "No se avisará a este navegador.",
  pushUnsupported: "Este navegador no puede mostrar notificaciones de sitios web.",
  pushUnavailable: "Este sitio todavía no envía notificaciones al navegador.",
  pushDenied:
    "Este navegador bloquea las notificaciones de este sitio. Permítelas en la configuración del navegador y luego vuelve a esta página.",
  pushFailure_signedOut:
    "Se cerró tu sesión. Vuelve a iniciar sesión para cambiar las notificaciones.",
  pushFailure_denied:
    "No se permitieron las notificaciones, así que no se avisará a este navegador.",
  pushFailure_service:
    "El servicio de notificaciones de este navegador no es uno por el que podamos enviar, así que no se le puede avisar.",
  pushFailure_failed: "Eso no funcionó. Inténtalo de nuevo.",
  pushNoticeTitle: "Algo nuevo en Abolish",
  pushNoticeBody:
    "Una decisión de moderación, o resultados de una encuesta que sigues. Abre la página de tu cuenta para ver cuál.",
  followResultsMark: "Encuestas que sigues",
  followResultsTitle: "Resultados de encuestas que seguiste",
  followResultsLede:
    "Cuando una encuesta que sigues tiene sus resultados, pasa aquí, y, a menos que lo hayas desactivado arriba, te avisamos por correo sin nombrarla. Solo tú puedes ver esta lista.",
  followResultsEmpty:
    "Todavía no hay nada aquí. Cuando una encuesta que sigues tenga sus resultados, la encontrarás aquí.",
  followResultsNoWords: "Una encuesta cuyas palabras no se pueden mostrar",
  followResultsSee: "Ver los resultados",
  followResultsRemove: "Quitarla de esta lista",
  followResultsRemoved: "Quitada de la lista.",
  followResultsMore: "Mostrar {count} más",
  followResultsReload: "Volver a cargar la lista",
  followResultsFailure_unlisted: "No se pudo cargar esta lista en este momento.",
  followResultsFailure_more:
    "No se pudo cargar el resto de la lista en este momento. Inténtalo de nuevo.",
  followResultsFailure_dropped: "Esa encuesta no se quitó de la lista. Inténtalo de nuevo.",
  followResultsFailure_signedOut:
    "Se cerró tu sesión. Vuelve a iniciar sesión para ver esta lista.",
  exportMark: "Tus datos",
  exportTitle: "Descarga tus datos",
  exportLede:
    "Una copia de los datos de tu cuenta, en un archivo JSON que puedes abrir con cualquier editor de texto.",
  exportHolds_account:
    "Cuándo se creó la cuenta, sus llaves de acceso, inicios de sesión y sesiones, y su nombre de moderador si modera",
  exportHolds_verification:
    "Tu dirección de correo verificada, donde este sitio aún pueda leerla, y los días en que se verificaron tu correo y tu teléfono",
  exportHolds_polls:
    "Cada encuesta que escribiste, tal como la escribiste, qué pasó con ella, y tus apelaciones",
  exportHolds_profile:
    "Tu perfil público, las encuestas que muestra, sus apelaciones y el día en que le pusiste nombre por última vez",
  exportHolds_reactions: "Tus reacciones a encuestas",
  exportHolds_follows: "Las encuestas que sigues, y las que seguías que ya tienen resultados",
  exportHolds_token:
    "El grupo, la región y el periodo de clave de tu token de Nivel 0, nunca la identidad de votación a la que se entregó",
  exportNever:
    "Nunca contiene tus respuestas, comprobantes ni tu identidad de votación: esos se quedan en tu dispositivo, y nuestros servidores no pueden vincularlos con tu cuenta. No contiene secretos de inicio de sesión ni tu número de teléfono: solo guardamos una huella con clave de él, que no está en el archivo.",
  exportCare:
    "Guarda el archivo en un lugar seguro: muestra cuándo usaste el sitio, y cualquiera que lo tenga puede leerlo.",
  exportDownload: "Descargar tus datos",
  exportPreparing: "Preparando tu archivo…",
  exportDone: "Tus datos se están descargando.",
  exportFailure_signedOut: "Se cerró tu sesión. Vuelve a iniciar sesión para descargar tus datos.",
  exportFailure_failed: "No se pudieron descargar tus datos. Inténtalo de nuevo.",
  accountDeleteMark: "Eliminar",
  accountDeleteTitle: "Eliminar tu cuenta",
  accountDeleteLede:
    "Esto elimina de nuestros servidores la cuenta, sus llaves de acceso, sus inicios de sesión y su perfil.",
  accountDeleteStays:
    "Las encuestas ya publicadas se quedan en el tablero público, y las decisiones de moderación sobre ellas se quedan en el registro público. Tu identidad de votación y tus comprobantes están en tu dispositivo y no se ven afectados.",
  accountDelete: "Eliminar cuenta…",
  accountDeleteQuestion: "¿Eliminar esta cuenta? No se puede deshacer.",
  accountDeleteConfirm: "Eliminar la cuenta para siempre",
  accountDeleteCancel: "Conservar la cuenta",
  accountFailure_cancelled: "Se cerró la solicitud de la llave de acceso. No cambió nada.",
  accountFailure_unsupported: "Este navegador no admite llaves de acceso.",
  profileMark: "Perfil",
  profileTitle: "Tu perfil público",
  profileLede:
    "Opcional. Un perfil pone un nombre que tú eliges junto a las encuestas que elijas, como “Pregunta de”. Muestra ese nombre y esas encuestas, nada más: ni tu cuenta, ni tu correo o teléfono, ni nada sobre las encuestas que respondes.",
  profileNone:
    "No tienes un perfil, así que tus encuestas no dicen quién las hizo. Puedes crear uno en cualquier momento, y eliminarlo en cualquier momento.",
  profileNeedsPhoneHere:
    "Un perfil necesita un número de teléfono verificado, y este sitio aún no verifica números de teléfono.",
  profileNameLabel: "El nombre que muestra tu perfil",
  profileNameHelp:
    "Una persona, un grupo o un seudónimo, de hasta 60 caracteres. Los nombres no se verifican ni tienen que ser únicos, y el nombre puede cambiar una vez al día. Los moderadores pueden ocultar un perfil con las mismas reglas que una encuesta.",
  profileMake: "Crear perfil",
  profileName: "Nombre",
  profileAddress: "Dirección",
  profileAddressHelp:
    "Elegida al azar, y nunca se le da a nadie más. Cualquiera que tenga la dirección ve el nombre y las encuestas que muestra el perfil.",
  profilePolls: "Encuestas que muestra",
  profilePollsNone:
    "Ninguna todavía. Tú eliges, debajo de cada una de tus encuestas, arriba, cuáles muestra.",
  profilePollsSome:
    "{count}. Tú eliges, debajo de cada una de tus encuestas, arriba, cuáles muestra.",
  profileRename: "Cambiar nombre",
  profileRenameSave: "Guardar nombre",
  profileRenameCancel: "Conservar el nombre",
  profileRenameOn: "El nombre se fijó hoy. Puede volver a cambiar el {day} (UTC).",
  profileRenameHidden: "El nombre no puede cambiar mientras el perfil está oculto.",
  profileDelete: "Eliminar perfil…",
  profileDeleteQuestion: "¿Eliminar tu perfil?",
  profileDeleteMeans:
    "Se eliminan su nombre y tu selección de encuestas, y su dirección se retira para siempre. Tus encuestas se quedan, sin “Pregunta de”. Pueden quedar copias que otros hicieron mientras se mostraba, como páginas guardadas.",
  profileDeleteConfirm: "Eliminar perfil",
  profileDeleteCancel: "Conservar perfil",
  profileMade: "Tu perfil está creado. No muestra ninguna encuesta hasta que las elijas.",
  profileRenamed: "El nombre cambió en tu perfil y en cada encuesta que muestra.",
  profileSameName: "Ese ya es su nombre. No cambió nada.",
  profileDeleted: "Tu perfil se eliminó.",
  profileAppealed: "Tu apelación se presentó. La revisará otro moderador.",
  profileMeans_visible: "Nuestras páginas vuelven a mostrar este perfil.",
  profileMeans_hidden:
    "Nuestras páginas muestran solo esta decisión en lugar del nombre y las encuestas del perfil, y tus encuestas no dicen quién las hizo. Las encuestas en sí no se ven afectadas.",
  profileAppeal_upheld: "aceptada el {when}\u00a0UTC, y el perfil restaurado",
  profileAppeal_rejected: "rechazada el {when}\u00a0UTC",
  profileAppeal_superseded:
    "cerrada el {when}\u00a0UTC, porque una decisión posterior cambió antes el perfil",
  profileVerifyPhone: "Verifica tu teléfono",
  profileFailure_signedOut: "Se cerró tu sesión. Vuelve a iniciar sesión para ver tu perfil.",
  profileFailure_phoneUnverified:
    "Un perfil necesita primero que verifiques tu número de teléfono.",
  profileFailure_invalidName:
    "Un perfil no puede tener ese nombre. Usa de 1 a 60 letras, dígitos, espacios o signos de puntuación, sin caracteres invisibles.",
  profileFailure_oneNameADay: "El nombre ya se fijó hoy. No cambió nada.",
  profileFailure_hidden:
    "El perfil está oculto, así que su nombre no puede cambiar. No cambió nada.",
  profileFailure_changed:
    "Tu perfil cambió desde que esta página lo leyó. Aquí se muestra cómo está ahora.",
  profileFailure_failed: "No funcionó. No cambió nada; inténtalo de nuevo en un momento.",
  profileFailure_unloaded: "No se pudo cargar tu perfil. Inténtalo de nuevo en un momento.",
  profileFailure_moderationUnloaded:
    "No se pudo cargar la moderación de este perfil. Inténtalo de nuevo en un momento.",
  profileChoiceLabel: "Mostrar en tu perfil,",
  profileChoiceLabelInList: "Mostrar en tu perfil",
  profileChoiceHelp:
    "Tu perfil lista esta encuesta, y su página dice que tu perfil la hizo, mientras la encuesta esté listada. Desmárcala cuando quieras.",
  profileChoiceHelpUnsaved:
    "Al guardar el borrador, se agrega a tu perfil. Tu perfil la lista, y su página dice que tu perfil la hizo, cuando la encuesta esté abierta y listada.",
  profileChoiceHelpUnopened:
    "Tu perfil lista esta encuesta, y su página dice que tu perfil la hizo, cuando la encuesta esté abierta y listada. Desmárcala cuando quieras.",
  profileChoiceShown: "Tu perfil muestra esta encuesta.",
  profileChoiceShownOnceOpen: "Tu perfil mostrará esta encuesta cuando se abra.",
  profileChoiceUnshown: "Tu perfil no muestra esta encuesta.",
  profileChoiceNone:
    "Tus encuestas no dicen quién las hizo. Para poner un nombre junto a ellas, crea un perfil público.",
  profileChoiceNoneLink: "Crea uno en la página de tu cuenta",
  profileChoiceFailure_signedOut: "Se cerró tu sesión. Vuelve a iniciar sesión para elegir.",
  profileChoiceFailure_changed:
    "Tu perfil o esta encuesta cambiaron desde que la página los leyó. Aquí no cambió nada.",
  profileChoiceFailure_failed: "No funcionó. No cambió nada; inténtalo de nuevo en un momento.",
  profileChoiceFailure_unsaved:
    "El borrador se guardó, pero tu perfil no lo muestra. Vuelve a marcar la casilla para mostrarlo.",
  byEyebrow: "Perfil",
  byLede:
    "Las encuestas que muestra este perfil, de la más reciente a la más antigua. Su autor eligió el nombre: los nombres no se verifican ni tienen que ser únicos.",
  byNote:
    "Qué encuestas muestra un perfil es lo que su autor le dijo a este sitio web. No forma parte de ninguna encuesta, y nadie fuera de este sitio web puede verificarlo.",
  byPolls: "Encuestas que hizo",
  askedBy: "Pregunta de",
  askedByNote:
    "Quién hizo la pregunta es lo que el autor de la encuesta le dijo a este sitio web. No forma parte de la encuesta, y nadie fuera de este sitio web puede verificarlo.",
  byEmpty: "No hay encuestas que mostrar",
  byEmptyLede: "Este perfil no muestra ninguna encuesta listada en este momento.",
  byMore: "Más encuestas",
  byHiddenTitle: "Este perfil está oculto",
  byHidden:
    "Los moderadores lo ocultaron según la política de moderación, por {reason}. Su nombre y sus encuestas no se muestran aquí, y sus encuestas no dicen quién las hizo. Las encuestas en sí se moderan por separado.",
  byHiddenLog: "Ver la decisión en el registro público de moderación",
  byReportTitle: "¿Algo anda mal con este perfil?",
  byReportHelp:
    "Se cuentan las denuncias, nunca quién las envió, y un moderador evalúa el perfil según la política: el número de denuncias nunca decide nada.",
  byReportPolicy: "Qué puede y qué no puede hacer la moderación",
  byReport: "Denunciar este perfil",
  byReportLegend: "¿Por qué debería revisarlo un moderador?",
  byReportSend: "Enviar denuncia",
  byReportCancel: "Cancelar",
  byReportDone: "Denunciado. Un moderador lo revisará.",
  byReportGone: "Este perfil ya no existe, así que no se denunció nada.",
  byReportFailed: "No funcionó. No se denunció nada; inténtalo de nuevo en un momento.",
  pollReportTitle: "¿Algo anda mal con esta encuesta?",
  pollReportHelp:
    "Cualquiera puede denunciar una encuesta, sin cuenta. Se cuentan las denuncias, nunca quién las envió, y un moderador evalúa la encuesta según la política: el número de denuncias nunca decide nada.",
  pollReport: "Denunciar esta encuesta",
  pollReportLegend: "¿Por qué debería revisarla un moderador?",
  pollReportGone: "Esta encuesta ya no está en nuestro servidor, así que no se denunció nada.",
  pollsMark: "Tus encuestas",
  pollsTitle: "Encuestas que creaste",
  pollsLede:
    "Tus borradores y cada encuesta que enviaste, se haya abierto o no. Solo tú ves esta lista: el registro público nunca dice quién creó una encuesta.",
  pollsEmpty: "Aún no has creado ninguna encuesta.",
  pollsUntitled: "Borrador sin título",
  pollsState_drafted: "Borrador",
  pollsState_setup: "En preparación",
  pollsState_open: "Abierta",
  pollsState_failed: "No se abrió",
  pollsState_closed: "Cerrada",
  pollsEdited: "Última edición: {when}\u00a0UTC",
  pollsSubmitted: "Enviada el {when}\u00a0UTC",
  pollsCloses: "Cierra el {when}\u00a0UTC",
  pollsClosed: "El {when}\u00a0UTC",
  pollsSetupHelp:
    "La preparación tarda un rato, sobre todo esperando a que el registro público se asiente. No necesitas hacer nada más: se abre sola, y esta lista muestra cuándo se abre, o por qué no se abrió. También puedes seguirla paso a paso.",
  pollsFollowSetup: "Seguir la preparación",
  pollsPage: "Ir a su página",
  pollsResults: "Ver sus resultados",
  pollsAskAgain: "Volver a hacerla",
  pollsDelete: "Eliminar borrador…",
  pollsDeleteQuestion: "¿Eliminar este borrador? No se puede deshacer.",
  pollsDeleteConfirm: "Eliminar el borrador para siempre",
  pollsReload: "Volver a cargar tus encuestas",
  pollsProfileIs: "Tu perfil es",
  pollsProfileHelp:
    "Al marcar “Mostrar en tu perfil” bajo una encuesta, tu perfil la lista, y su página dice que tu perfil la hizo, mientras la encuesta esté listada. Una encuesta que aún no se ha abierto se lista cuando se abra. Desmarca una casilla cuando quieras.",
  pollsRetry: "Editar y volver a enviar",
  pollsDiscard: "Descartar…",
  pollsDiscardQuestion: "¿Descartar esta encuesta y su borrador? No se puede deshacer.",
  pollsDiscardConfirm: "Descartar para siempre",
  pollsKeep: "Conservarla",
  pollsRemoved: "El borrador se eliminó.",
  pollsDiscarded: "La encuesta se descartó.",
  pollsFailure_signedOut: "Se cerró tu sesión. Vuelve a iniciar sesión para ver tus encuestas.",
  pollsFailure_gone: "Esa encuesta ya no está aquí. La lista ya está actualizada.",
  pollsFailure_changed:
    "Esa encuesta cambió desde que se mostró la lista. La lista ya está actualizada.",
  pollsFailure_registered: "Esa encuesta está registrada en el registro público, así que se queda.",
  pollsFailure_tooManyDrafts:
    "Tienes tantos borradores como admite una cuenta. Elimina uno e inténtalo de nuevo.",
  pollsFailure_failed: "No funcionó. No cambió nada; inténtalo de nuevo en un momento.",
  pollsFailure_unlisted: "No se pudieron cargar tus encuestas en este momento.",
  pollsFailure_refused:
    "El servidor encontró un problema con ese borrador, así que no se guardó. Revísalo e inténtalo de nuevo.",
  moderationOfPoll: "Moderación",
  moderationDecision: "{action}: {reason}, {when}\u00a0UTC",
  moderationDecisionWhat: "{action}: {reason}",
  moderationDecidedOn: "El {when}\u00a0UTC, decisión N.º\u00a0{seq}",
  moderationMeans_visible: "Nuestras páginas vuelven a listar y mostrar esta encuesta.",
  moderationMeans_delisted:
    "Nuestras páginas no listan esta encuesta, pero sigue abierta en su dirección. El tablero, el conteo y el resultado no se ven afectados.",
  moderationMeans_hidden:
    "Nuestras páginas no muestran el texto de esta encuesta. El tablero, el conteo y el resultado no se ven afectados.",
  moderationAppealed: "Apelaste la decisión N.º {seq} el {when}\u00a0UTC: {outcome}.",
  moderationAppealPending: "en espera de un moderador distinto del que decidió",
  moderationAppeal_upheld: "aceptada el {when}\u00a0UTC, y la encuesta restaurada",
  moderationAppeal_rejected: "rechazada el {when}\u00a0UTC",
  moderationAppeal_superseded:
    "cerrada el {when}\u00a0UTC, porque una decisión posterior cambió antes la encuesta",
  moderationAppeal: "Apelar esta decisión…",
  moderationAppealQuestion:
    "¿Apelar esta decisión? La revisa un moderador distinto del que decidió. Solo puedes apelar una decisión una vez.",
  moderationAppealConfirm: "Enviar apelación",
  moderationAppealCancel: "Ahora no",
  moderationAppealFiled: "Tu apelación se presentó.",
  moderationFailure_signedOut:
    "Se cerró tu sesión. Vuelve a iniciar sesión para ver la moderación de esta encuesta.",
  moderationFailure_gone: "Esa encuesta ya no está aquí.",
  moderationFailure_changed:
    "Esa decisión cambió o ya se apeló desde que esta página la leyó. Aquí ves cómo está ahora.",
  moderationFailure_failed:
    "La apelación no se envió. No cambió nada; inténtalo de nuevo en un rato.",
  moderationFailure_unloaded: "No se pudo cargar la moderación de esta encuesta en este momento.",
  moderationReload: "Volver a cargar su moderación",
  moderationLogAt: "Verla en el registro de moderación",
  moderationNone: "La moderación no ha decidido nada sobre esta encuesta.",
  pollsFailure_tooManyInSetup:
    "Tienes tantas encuestas en preparación como una cuenta puede tener a la vez. Envía esta cuando una de ellas se haya abierto.",
  pollsFailure_tooManyToday:
    "Enviaste tantas encuestas en las últimas 24 horas como una cuenta puede. Inténtalo de nuevo más tarde.",
  pollsFailure_challengeRefused:
    "La verificación de que eres una persona no se superó, así que no se envió nada. Envía de nuevo para hacer otra.",
  pollsFailure_challengeUnavailable:
    "La verificación de que eres una persona no pudo hacerse en este momento, así que no se envió nada. Inténtalo de nuevo en un rato.",
  pollsCreate: "Hacer una pregunta",
  pollsEdit: "Editar borrador",
  pollFormEyebrow: "Tus encuestas",
  pollFormNewEyebrow: "Nueva encuesta",
  pollFormNewTitle: "Hacer una pregunta",
  pollFormEditTitle: "Edita tu encuesta",
  pollFormLede:
    "Solo tú puedes ver un borrador, y puedes cambiarlo cuantas veces quieras hasta que lo envíes.",
  pollFormCopiedLede:
    "Ya están puestas tus palabras de la encuesta que no abrió. Elige cuándo cierra esta; solo tú puedes verla hasta que la envíes.",
  pollFormBack: "Volver a tus encuestas",
  pollFormNeedsScript: "Para guardar un borrador se necesita el script de esta página.",
  pollFormLoading: "Cargando tu borrador…",
  pollFormSignedOut:
    "Se cerró tu sesión. Inicia sesión en la página de tu cuenta y luego vuelve a este borrador.",
  pollFormGone: "Ese borrador ya no está aquí. Puede que se haya eliminado en otra pestaña.",
  pollFormNotDraft:
    "Esta encuesta se envió para su preparación, así que ya no se puede cambiar. Tu lista de encuestas muestra cómo va.",
  pollFormUnloaded: "No se pudo cargar tu borrador. Inténtalo de nuevo en un rato.",
  setupEyebrow: "Tus encuestas",
  setupTitle: "Preparando tu encuesta",
  setupLede:
    "Antes de que alguien pueda responder, tu encuesta pasa al registro público, se cuenta a las personas que pueden responder y sus custodios crean la clave que sella cada respuesta. Esto puede tardar hasta media hora, casi todo esperando a que el registro público se asiente.",
  setupBack: "Volver a tus encuestas",
  setupNeedsScript:
    "Para seguir la preparación se necesita el script de esta página. Tu lista de encuestas en la página de tu cuenta muestra cómo va.",
  setupLoading: "Cargando tu encuesta…",
  setupSignedOut:
    "Se cerró tu sesión. Inicia sesión en la página de tu cuenta para ver cómo va tu encuesta.",
  setupGone: "Esa encuesta ya no está aquí. Puede que se haya descartado en otra pestaña.",
  setupUnloaded:
    "No se pudo cargar tu encuesta. Esta página lo intentará de nuevo en unos segundos.",
  setupStepsLabel: "Preparación, paso a paso",
  setupStep_submitted: "Enviada",
  setupStep_created: "Pasa al registro público",
  setupStep_rooted: "Se cuenta a quienes pueden responder",
  setupStep_keyed: "Los custodios crean la clave que sella las respuestas",
  setupStep_opened: "Revisada y abierta a respuestas",
  setupWhere_done: "listo",
  setupWhere_now: "en curso",
  setupWhere_later: "pendiente",
  setupNow: "Ahora: {step}.",
  setupLeave:
    "Esta página vuelve a revisar cada pocos segundos. Puedes salir: la preparación continúa y tu lista de encuestas muestra cómo va.",
  setupStale:
    "Esta página no pudo revisar en este momento. Lo intentará de nuevo en unos segundos.",
  setupOpen: "Tu encuesta está abierta.",
  setupOpenUntil: "Se puede responder hasta el {when} UTC.",
  setupPollPage: "Ir a la página de tu encuesta",
  setupDraft: "Esta encuesta no se ha enviado, así que no se está preparando nada.",
  setupFailed: "Tu encuesta no se abrió.",
  setupFailedNext: "Volver a tus encuestas para volver a enviarla o descartarla",
  pollFormAboutTitle: "¿De qué trata?",
  pollFormTitleLabel: "Título",
  pollFormTitleHelp: "Lo primero que se ve, en las listas y en la página de la encuesta.",
  pollFormDescriptionLabel: "Descripción",
  pollFormOptional: "(opcional)",
  pollFormDescriptionHelp: "El contexto que hace falta para responder con justicia.",
  pollFormPlaceLabel: "Lugar",
  pollFormPlaceHelp:
    "Una ciudad, un barrio, una escuela. Cualquiera puede verlo, así que indica un lugar público y no tu propia dirección.",
  pollFormTopicLabel: "Tema",
  pollFormTopicHelp: "Ayuda a que encuentren tu encuesta.",
  pollFormTopicNone: "Sin tema",
  pollFormTagsNote:
    "El lugar y el tema solo deciden dónde aparece tu encuesta. No forman parte de la encuesta en sí, y la moderación puede cambiarlos si no encajan.",
  pollFormQuestionsTitle: "¿Qué preguntas?",
  pollFormQuestionsLede:
    "Cada pregunta tiene sus opciones y una regla de cuántas elige una respuesta. Cada respuesta a tu encuesta responde a todas sus preguntas.",
  pollFormQuestion: "Pregunta {n}",
  pollFormQuestionLabel: "¿Qué quieres preguntar?",
  pollFormQuestionDescriptionLabel: "Explicación",
  pollFormQuestionDescriptionHelp: "Una o dos líneas bajo la pregunta.",
  pollFormRuleLegend: "¿Cuántas opciones elige una respuesta?",
  pollFormRule_one: "Una",
  pollFormRule_any: "Cualquier cantidad",
  pollFormRule_upTo: "Hasta cierta cantidad",
  pollFormRule_exactly: "Una cantidad exacta",
  pollFormRule_between: "Entre dos cantidades",
  pollFormMinLabel: "Al menos",
  pollFormMaxLabel_upTo: "Hasta",
  pollFormMaxLabel_exactly: "Exactamente",
  pollFormMaxLabel_between: "Como máximo",
  pollFormOptionalLabel: "Se puede dejar esta pregunta en blanco",
  pollFormOptionsLegend: "Opciones",
  pollFormOption: "Opción {n}",
  pollFormOptionDescriptionLabel: "Detalles de la opción {n}",
  pollFormAddOption: "Agregar una opción",
  pollFormAddOptionTo: "a la pregunta {n}",
  pollFormAddQuestion: "Agregar una pregunta",
  pollFormMoveUp: "Subir {what}",
  pollFormMoveDown: "Bajar {what}",
  pollFormRemove: "Quitar {what}",
  pollFormWhatQuestion: "la pregunta {n}",
  pollFormWhatOption: "la opción {n} de la pregunta {q}",
  pollFormWhoTitle: "¿Quién puede responder?",
  pollFormWhoLede_email:
    "Por ahora, todas las encuestas están abiertas a las mismas personas. Cada correo electrónico verificado cuenta una vez, así que alguien con dos direcciones podría responder dos veces: los resultados cuentan direcciones, no personas.",
  pollFormWhoLede_phone:
    "Por ahora, todas las encuestas están abiertas a las mismas personas. Cada número de teléfono verificado cuenta una vez, así que alguien con dos números podría responder dos veces: los resultados cuentan números, no personas.",
  pollFormWho_email: "Personas con un correo electrónico verificado",
  pollFormWho_phone: "Personas con un correo electrónico y un número de teléfono verificados",
  pollFormWhenTitle: "¿Cuándo cierra?",
  pollFormWhenLede:
    "Elige una hora de tu propio reloj ({zone}), entre 90 minutos y un año a partir de ahora.",
  pollFormDateLabel: "Fecha de cierre",
  pollFormTimeLabel: "Hora de cierre",
  pollFormUtc:
    "Quienes respondan la verán como el {when} UTC, el reloj que usan todas las encuestas.",
  pollFormOpenFor:
    "Si la envías ahora, se abre tras una media hora de preparación y queda abierta alrededor de {length}.",
  pollFormOpenDays: { one: "{count} día", other: "{count} días" },
  pollFormOpenHours: { one: "{count} hora", other: "{count} horas" },
  pollFormOpenDaysHours: "{days} y {hours}",
  pollFormPreviewTitle: "Lo que se verá",
  pollFormPreviewEmpty: "El título de tu encuesta",
  pollFormPreviewQuestionEmpty: "Tu pregunta",
  pollFormPreviewOptionEmpty: "Una opción",
  pollFormPreviewCloses: "Cierra el {when} UTC",
  pollFormPreviewChooseOne: "Escoge una.",
  pollFormPreviewChooseAny: "Escoge todas las que quieras.",
  pollFormPreviewChooseUpTo: "Escoge hasta {count}.",
  pollFormPreviewChooseExactly: { one: "Escoge una.", other: "Escoge exactamente {count}." },
  pollFormPreviewChooseAtLeast: { one: "Escoge al menos una.", other: "Escoge al menos {count}." },
  pollFormPreviewChooseBetween: "Escoge de {min} a {max}.",
  pollFormPreviewCantSkip: "Esta pregunta no se puede omitir.",
  pollFormPreviewListed: "Dónde aparece",
  pollFormPreviewNotListed: "No aparece bajo ningún tema ni lugar.",
  pollFormReviewTitle: "Revísala",
  pollFormReviewLede:
    "Esto es lo que vas a enviar. Cambia lo que quieras en esta página y guarda antes de enviar.",
  pollFormReviewPermanent: "Registrado para siempre",
  pollFormReviewPermanentLede:
    "Esto pasa al registro público cuando envías. Nadie puede cambiarlo después, ni tú ni nosotros.",
  pollFormReviewListing: "Dónde aparece",
  pollFormReviewListingLede:
    "Esto no forma parte de la encuesta. Decide dónde la encuentran, y la moderación puede cambiarlo.",
  pollFormReviewModeration: "Lo que puede hacer la moderación",
  pollFormReviewModerationLede:
    "Si tu encuesta incumple uno de los siete motivos de nuestra política de moderación, un moderador puede quitarla de nuestras listas u ocultar su texto en nuestras páginas, y archivarla en otro tema o lugar si el suyo no corresponde. Cada decisión queda en el registro público, y puedes apelar una vez, desde tu cuenta, que la quiten de las listas o la oculten. Ocultar una encuesta abierta por contenido ilegal o por los datos personales de alguien también impide responderla desde nuestra aplicación hasta que se restaure. La moderación nunca toca las respuestas ni el recuento, y no puede cerrar tu encuesta antes de tiempo.",
  pollFormReviewTitleRow: "Título",
  pollFormReviewDescription: "Descripción",
  pollFormReviewQuestions: "Preguntas",
  pollFormReviewQuestionCount: { one: "{count} pregunta", other: "{count} preguntas" },
  pollFormReviewWho: "Quién puede responder",
  pollFormReviewCloses: "Cierra",
  pollFormReviewKey: "Quién tiene la clave",
  pollFormReviewKeyValue:
    "Durante el lanzamiento, solo Abolish tiene la clave de esta encuesta, así que sus respuestas no son secretas para nosotros. Los fideicomisarios independientes que se nombren después no lo cambiarán para esta encuesta, y aún no se ofrece añadir fideicomisarios propios.",
  pollFormReviewKeyLink: "Cómo funciona la clave",
  pollFormReviewPlace: "Lugar",
  pollFormReviewTopic: "Tema",
  pollFormReviewNone: "Ninguno",
  pollFormReviewNotSet: "Sin definir",
  pollFormReviewClosesAt: "{when} en tu hora ({utc} UTC)",
  pollFormReviewUntitled: "Aún sin título",
  pollFormReviewNoDescription: "Sin descripción",
  pollFormReviewNoQuestion: "Aún sin pregunta",
  pollFormReviewChange: "Cambiar",
  pollFormSave: "Guardar borrador",
  pollFormSaved: "Tu borrador está guardado.",
  pollFormSubmitTitle: "¿Listo para preguntar?",
  pollFormSubmitLede:
    "Al enviarla, tu encuesta se prepara en el registro público y se abre a respuestas cuando eso termina, una media hora después. Luego debe seguir abierta al menos una hora. No puedes cambiarla después de enviarla.",
  pollFormSubmitCloudflare:
    "Antes de enviarla, una verificación de Cloudflare confirma que eres una persona. Cloudflare ve la dirección de tu navegador mientras se ejecuta.",
  pollFormSubmit: "Enviar encuesta",
  pollFormSubmitAfterSave: "Primero guarda tu borrador. Después podrás revisarlo aquí y enviarlo.",
  pollFormSubmitCheckLabel: "Verifica que eres una persona",
  pollFormSubmitChecking: "Completa la verificación para enviar tu encuesta.",
  pollFormSubmitting: "Enviando tu encuesta…",
  pollFormSubmitted: "Tu encuesta se envió. Te llevamos a su preparación…",
  pollFormSubmitSaveFirst: "Primero guarda tu borrador: solo se puede enviar un borrador guardado.",
  pollFormSubmitUnavailable: "En este momento no se pueden enviar encuestas en este sitio.",
  pollFormSubmitRefused:
    "El servidor encontró un problema con este borrador, así que no se envió. Revisa cuándo cierra, guárdalo e inténtalo de nuevo.",
  pollFormErrorsTitle: "Tu borrador no se guardó",
  pollFormSubmitErrorsTitle: "Tu encuesta no se envió",
  pollFormErrorsLede: "Corrige esto y vuelve a guardar:",
  pollFormInQuestion: "Pregunta {n}: {problem}",
  pollFormInOption: "Pregunta {n}, opción {o}: {problem}",
  pollFormInField: "{field}: {problem}",
  pollFormInExplanation: "Pregunta {n}, explicación: {problem}",
  pollFormInDetails: "Pregunta {n}, detalles de la opción {o}: {problem}",
  pollForm_titleMissing: "Ponle un título a tu encuesta.",
  pollForm_tooLong: "Esto es demasiado largo.",
  pollForm_unstorable: "Esto contiene un carácter que no se puede guardar. Vuelve a escribirlo.",
  pollForm_placeTooLong: "Un lugar puede tener hasta 80 letras.",
  pollForm_placeRefused:
    "Esto contiene un carácter oculto o una marca de dirección de texto que un lugar no puede tener. Vuelve a escribirlo.",
  pollForm_questionMissing: "Escribe la pregunta.",
  pollForm_questionRepeated:
    "Otra pregunta ya pregunta esto. Cada pregunta necesita sus propias palabras.",
  pollForm_labelMissing: "Escribe el texto de esta opción o quítala.",
  pollForm_labelRepeated: "Otra opción de esta pregunta dice lo mismo. No se podrían distinguir.",
  pollForm_tooFewOptions: "Una pregunta necesita al menos dos opciones.",
  pollForm_tooManyOptions: "Una encuesta puede tener 64 opciones entre todas sus preguntas.",
  pollForm_tooManyQuestions: "Una encuesta puede tener 32 preguntas.",
  pollForm_rangeInvalid:
    "Estos números no encajan con las opciones: una respuesta debe poder elegir al menos una, y no más de las que hay.",
  pollForm_closesMissing: "Elige una fecha y hora de cierre.",
  pollForm_closesSkipped:
    "Tu reloj se salta esa hora cuando se adelanta una hora. Elige otra hora.",
  pollForm_closesTooSoon: "Elige una hora al menos 90 minutos a partir de ahora.",
  pollForm_closesTooLate: "Elige una hora dentro del próximo año como máximo.",
  pollForm_draftTooLong:
    "Tu encuesta es demasiado larga en total. Acorta el texto o quita una pregunta.",
  pollForm_draftRefused:
    "Tu encuesta incumple una regla que el formulario no pudo señalar. Revísala.",
  pollTopic_community: "Comunidad",
  pollTopic_culture: "Cultura",
  pollTopic_economy: "Economía",
  pollTopic_education: "Educación",
  pollTopic_environment: "Medio ambiente",
  pollTopic_food: "Comida",
  pollTopic_government: "Gobierno",
  pollTopic_health: "Salud",
  pollTopic_housing: "Vivienda",
  pollTopic_safety: "Seguridad",
  pollTopic_science: "Ciencia",
  pollTopic_sport: "Deporte",
  pollTopic_technology: "Tecnología",
  pollTopic_transport: "Transporte",
  verifyEyebrow: "Cuenta · Verificación",
  verifyPageTitle_email: "Verifica tu correo electrónico",
  verifyPageTitle_phone: "Verifica tu correo y tu teléfono",
  verifyPageLede_email:
    "Para votar se necesita una cuenta verificada con un correo electrónico, y cada dirección verifica una sola cuenta. Nunca llega a una encuesta, a una boleta ni al registro público.",
  verifyPageLede_phone:
    "Para votar se necesita una cuenta verificada con un correo electrónico y un número de teléfono, y cada número verifica una sola cuenta. Así una persona no puede crear muchas cuentas con la misma facilidad que muchas llaves de acceso. Te pedimos el número la primera vez que votas, o puedes verificarlo ahora. Ninguno de los dos llega nunca a una encuesta, a una boleta ni al registro público.",
  verifyBack: "Volver a tu cuenta",
  verifyNeedsScript: "Para verificar se necesita el script de esta página.",
  verifyCloudflare:
    "Antes de enviar un código, una verificación de Cloudflare confirma que eres una persona. Cloudflare ve la dirección de tu navegador mientras se ejecuta.",
  verifyMark_email: "Correo",
  verifyMark_phone: "Teléfono",
  verifyHeading_email: "Tu correo electrónico",
  verifyHeading_phone: "Tu número de teléfono",
  verifyLede_email:
    "Guardamos tu dirección cifrada, para enviarte códigos y, más adelante, los avisos que pidas. Nunca se le muestra a nadie más.",
  verifyLede_phone:
    "Nunca guardamos tu número: solo una huella con clave, para que no pueda verificar una segunda cuenta. Un celular recibe un mensaje de texto; un teléfono fijo, una llamada. El proveedor que envía el código ve el número.",
  verifyLoading: "Cargando…",
  verifyVerified_email: "Verificado: {address}, el {date} UTC.",
  verifyVerified_phone:
    "Verificado el {date}. No guardamos el número, así que no podemos mostrarlo.",
  verifyNone_email: "Aún no hay ninguna dirección verificada.",
  verifyNone_phone: "Aún no hay ningún número de teléfono verificado.",
  verifyChange_email: "Usar otra dirección",
  verifyChange_phone: "Usar otro número",
  verifyLabel_email: "Correo electrónico",
  verifyLabel_phone: "Número de teléfono",
  verifyHelp_email: "Te enviamos un código de 8 dígitos.",
  verifyHelp_phone:
    "Un número de EE. UU. o Canadá, con o sin +1. No se pueden usar números de internet ni virtuales.",
  verifySend: "Enviar un código",
  verifyCheckLabel: "Verifica que eres una persona",
  verifyChecking: "Completa la verificación para enviar tu código.",
  verifySending: "Enviando tu código…",
  verifySent_email:
    "Enviamos un mensaje a {address}. Ingresa el código que contiene; sirve durante 15 minutos. ¿No llegó nada? Revisa la dirección y envía otro.",
  verifySent_phone:
    "Si {number} puede recibir un código, ya va en camino, por mensaje de texto a un celular o por llamada a un teléfono fijo. Sirve durante 10 minutos. ¿No llegó nada? Revisa el número y envía otro.",
  verifyCodeLabel: "Código",
  verifyCodeSubmit: "Verificar",
  verifyStartOver: "Empezar de nuevo",
  verifyCancel: "Cancelar",
  verifyChecked_email: "Tu correo electrónico está verificado.",
  verifyChecked_phone: "Tu número de teléfono está verificado.",
  verifyNoTarget_email: "Ingresa tu correo electrónico.",
  verifyNoTarget_phone: "Ingresa tu número de teléfono.",
  verifyNoCode: "Ingresa el código que te enviamos.",
  verifyFailure_signedOut:
    "Se cerró tu sesión. Inicia sesión en la página de tu cuenta y luego vuelve.",
  verifyFailure_unavailable: "Este sitio aún no puede verificar esto.",
  verifyFailure_invalidAddress:
    "Ese no es un correo electrónico al que podamos enviar. Revísalo e inténtalo de nuevo.",
  verifyFailure_invalidNumber: "Ese no es un número de teléfono. Revísalo e inténtalo de nuevo.",
  verifyFailure_unsupportedCountry:
    "Por ahora solo podemos verificar números de EE. UU. y Canadá. Lo sentimos: sin uno, todavía no puedes verificar una cuenta.",
  verifyFailure_virtualNumber:
    "Parece un número de internet o virtual. Usa un celular o un teléfono fijo.",
  verifyFailure_tooManyThisHour:
    "Ya pediste todos los códigos que puedes en esta hora. Inténtalo de nuevo en una hora.",
  verifyFailure_tooManyToday:
    "Ya pediste todos los códigos que puedes hoy. Inténtalo de nuevo mañana.",
  verifyFailure_serviceBusy:
    "Hoy ya enviamos todos los códigos por teléfono que podemos. Inténtalo de nuevo mañana.",
  verifyFailure_challengeRefused:
    "La verificación de que eres una persona no se completó. Envía el código de nuevo para hacer otra.",
  verifyFailure_challengeUnavailable:
    "La verificación de que eres una persona no pudo cargarse. Inténtalo de nuevo en un rato.",
  verifyFailure_lookupUnavailable:
    "No pudimos revisar ese número en este momento. Inténtalo de nuevo en un rato.",
  verifyFailure_noCode: "No hay ningún código pendiente para esto. Envía uno nuevo.",
  verifyFailure_expired: "Ese código venció. Envía uno nuevo.",
  verifyFailure_wrongCode: "Ese código no es correcto. Revísalo e inténtalo de nuevo.",
  verifyFailure_wrongCodeTries:
    "Ese código no es correcto. Intentos restantes para este código: {count}.",
  verifyFailure_tooManyTries: "Ese código tuvo demasiados intentos fallidos. Envía uno nuevo.",
  verifyFailure_checkUnavailable:
    "No pudimos revisar el código en este momento. No se gastó ningún intento: inténtalo de nuevo en un rato.",
  verifyFailure_addressTaken:
    "Esta dirección no puede verificar esta cuenta: otra cuenta ya la verificó, o una la liberó hace menos de 90 días.",
  verifyFailure_numberHeld:
    "Este número no puede verificar esta cuenta: otra cuenta lo tiene, o una lo liberó hace menos de 90 días.",
  verifyFailure_failed: "Eso no funcionó. No cambió nada; inténtalo de nuevo en un rato.",
  verificationMark: "Verificación",
  verificationTitle_email: "Correo",
  verificationTitle_phone: "Correo y teléfono",
  verificationLede_email:
    "Para votar se necesita un correo electrónico verificado: una cuenta por dirección.",
  verificationLede_phone:
    "Para votar se necesitan un correo electrónico y un número de teléfono verificados: una cuenta por número. Te pedimos el número la primera vez que votas.",
  verificationPhoneLater: "Se pide la primera vez que votas",
  verificationEmail: "Correo",
  verificationPhone: "Teléfono",
  verificationEmailDone: "Verificado: {address}",
  verificationPhoneDone: "Verificado el {date}",
  verificationNotYet: "Aún no verificado",
  verificationUnavailable: "Aún no disponible en este sitio",
  verificationUnread: "No se pudo cargar",
  verificationGo: "Verifica tu correo electrónico",
  verificationManage_email: "Cambia tu correo",
  verificationManage_phone: "Administra tu correo y tu teléfono",
  accountFailure_failedSignedOut: "Eso no funcionó. No cambió nada; inténtalo de nuevo en un rato.",
  accountFailure_failed:
    "Eso no funcionó. Para agregar una llave de acceso o eliminar la cuenta se necesita haber iniciado sesión en el último día: cierra sesión, vuelve a iniciarla e inténtalo de nuevo.",
  footerLanguage: "Idioma",
};
