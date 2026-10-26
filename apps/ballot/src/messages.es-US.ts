import type { Messages } from "./messages.ts";

// The ballot client in US Spanish (P2-28 part 4b), in the website's voice
// and glossary (apps/web/src/messages.es-US.ts): `tú`, encuesta, boleta,
// boleta sellada, tablero público, comprobante, código de seguimiento,
// custodio, puesto, llave de acceso, identidad de votación, huella, sello.

export const esUS: Messages = {
  // The frame (frame.tsx).
  name: "Boleta de Abolish",
  sealLabel: "Sello de esta encuesta, {hash}",
  definitionLabel: "Huella de la definición de la elección {hash}",
  election: "Elección {hash}",
  askedBy: "Pregunta de {name}",
  closes: "Cierra el {when}",
  questionOf: "Pregunta {current} de {total}",
  stepOf: "Paso {current} de {total}",
  stepNamed: "{step}: {name}",
  languageLabel: "Idioma",
  // What this client is, before any poll is open.
  title: "Boleta de Abolish",
  lede: "Para votar, abre el enlace de la boleta de tu elección.",
  localTitle: "Tus respuestas se quedan en este dispositivo hasta que se sellan",
  local:
    "Esta página no carga nada de ningún otro sitio, y tus elecciones salen de este dispositivo solo cifradas.",
  // Refused on a shared origin (origin.ts).
  sharedOriginTitle: "Esta dirección no es segura para votar",
  sharedOrigin:
    "Esta copia de la boleta se sirve desde una dirección que comparten otros sitios, así que podrían leerla.",
  sharedOriginAddress: "La dirección que abriste",
  nothingSentTitle: "No se envió nada",
  nothingSent:
    "No se mostró ninguna boleta y no se envió nada de lo que escogiste. No has perdido tu oportunidad de votar.",
  otherAddressTitle: "Abre la boleta desde otra dirección",
  otherAddress: "Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  // Opening a poll from its link (open.tsx).
  checkingTitle: "Comprobando esta encuesta",
  checking:
    "Antes de mostrarte nada, este dispositivo está comprobando la encuesta con el registro público de elecciones.",
  brokenLinkTitle: "Este enlace no abre ninguna encuesta",
  brokenLink:
    "Puede que falte parte del enlace. Pídele el enlace otra vez a quien te lo envió, o abre la boleta desde la página de la encuesta.",
  noRegistryTitle: "Esta copia de la boleta todavía no puede comprobar encuestas",
  noRegistry:
    "No indica ningún registro de elecciones con el que comprobarlas, así que no mostrará ninguna. No se envió nada.",
  wrongChainTitle: "No se pudo leer el registro de elecciones",
  wrongChain:
    "La red que leyó este dispositivo no es aquella en la que esta boleta comprueba las encuestas, así que se detuvo antes de mostrar nada.",
  notRegisteredTitle: "Esta encuesta no está registrada",
  notRegistered:
    "El registro público de elecciones no tiene ninguna encuesta con el número de este enlace, o se registró hace una media hora o menos. Revisa el enlace, o inténtalo más tarde.",
  notFoundTitle: "Las preguntas de esta encuesta no están disponibles",
  notFound:
    "La encuesta está registrada, pero el servidor no tenía sus preguntas. Inténtalo más tarde, o abre la boleta desde otra dirección.",
  withheldTitle: "El texto de esta encuesta está retenido",
  withheld:
    "Sus preguntas están retenidas según la política de moderación de Abolish, así que este dispositivo no puede mostrarlas. No se envió nada.",
  hiddenAsThreatTitle: "Oculta en el sitio web de Abolish por ser una amenaza",
  hiddenAsThreat:
    "Un moderador ocultó el texto de esta encuesta en el sitio web de Abolish, por una amenaza de violencia. Mientras la encuesta esté abierta, esta boleta la sigue mostrando, comprobada con la huella registrada de la encuesta, para que ocultarla no impida votar a nadie. La moderación nunca toca las boletas ni los resultados.",
  unreachableTitle: "Este dispositivo no pudo comunicarse con los servidores",
  unreachable: "Revisa tu conexión e inténtalo otra vez. No se envió nada.",
  badAnswerTitle: "Un servidor envió algo que no es una encuesta",
  badAnswer:
    "Este dispositivo se detuvo antes de mostrar nada. Inténtalo más tarde, o abre la boleta desde otra dirección.",
  workerFailedTitle: "Este dispositivo no pudo comprobar la encuesta",
  workerFailed:
    "La comprobación se detuvo antes de terminar. Inténtalo otra vez. No se envió nada.",
  tryAgain: "Intentar otra vez",
  answerAgain: "Responder otra vez",
  // The arrival check (check.tsx).
  realPoll: "Esta es la encuesta real, comprobada",
  realPollExplained:
    "Antes de mostrarte nada, este dispositivo comprobó que estas preguntas son exactamente las registradas para esta encuesta. El sello se dibuja a partir de ellas; la página de la encuesta muestra el mismo.",
  registeredFingerprint: "La huella registrada de la encuesta",
  checksLabel: "Comprobaciones antes de votar",
  checksTitle: "Lo que comprobó este dispositivo",
  passed: "Superada",
  failed: "Fallida",
  ownOriginCheck: "Se ejecuta desde una dirección propia",
  ownOriginCheckDetail: "Se sirve desde {origin}, que ningún otro sitio comparte.",
  registeredCheck: "Esta es la elección que se registró",
  registeredCheckDetail:
    "La definición de la elección tiene el mismo hash que la del registro público de elecciones. Su huella está en la barra superior.",
  registeredHash: "Hash de la definición registrada",
  registeredFingerprintOf: "Huella de la definición registrada, {hash}",
  servedHash: "Hash de la definición que sirvió este enlace",
  servedFingerprintOf: "Huella de la definición que sirvió este enlace, {hash}",
  // Refused after the election check (check.tsx); each failed check in words.
  refusedTitle: "No votes desde este enlace",
  refused:
    "Falló una comprobación de la elección que abrió este enlace, así que este dispositivo se detuvo antes de mostrar una boleta. No se envió nada de lo que escogiste.",
  ruleBroken: "La regla que incumple, como la nombra la especificación:",
  definitionUndecodable: "No se puede leer la definición de la elección",
  definitionUndecodableDetail:
    "Lo que este enlace sirvió como definición de la elección no es un registro válido, así que este dispositivo no puede saber qué elección es.",
  anotherElection: "La definición es de otra elección",
  anotherElectionDetail: "El enlace indica una elección, y la definición que sirvió indica otra.",
  unregisteredDefinition: "La elección no coincide con el registro",
  unregisteredDefinitionDetail:
    "La definición que sirvió este enlace tiene un hash distinto del registrado para esta elección. Las dos huellas de abajo deberían ser idénticas, y no lo son.",
  definitionIllFormed: "La definición de la elección incumple las reglas",
  definitionIllFormedDetail:
    "Coincide con el registro, pero incumple una regla que toda elección debe seguir, así que este dispositivo no la mostrará.",
  displayTextUndecodable: "No se puede leer el texto de las preguntas",
  displayTextUndecodableDetail:
    "Lo que este enlace sirvió como preguntas y opciones no es un registro válido, así que este dispositivo no lo mostrará.",
  displayTextChanged: "El texto no es el que se registró",
  displayTextChangedDetail:
    "Las preguntas y opciones que sirvió este enlace no son las que fijó la elección registrada. Puede que alguien haya cambiado lo que dice una opción.",
  displayTextIllFormed: "El texto de las preguntas incumple las reglas",
  displayTextIllFormedDetail:
    "Las preguntas y opciones que sirvió este enlace incumplen una regla que debe seguir el texto de toda elección, así que este dispositivo no las mostrará.",
  panelUnpinned: "Los custodios de la encuesta no son unos que esta boleta conozca",
  panelUnpinnedDetail:
    "La encuesta indica un panel de custodios que esta versión de la boleta no tiene en su lista, así que este dispositivo no puede saber para qué claves cifraría tus respuestas.",
  ceremonyMissing: "El registro de las claves de los custodios no está disponible",
  ceremonyMissingDetail:
    "Este enlace no sirvió el registro público de cómo crearon sus claves los custodios de la encuesta, así que este dispositivo no puede saber para qué claves cifraría tus respuestas. Puede que la encuesta sea demasiado nueva: inténtalo más tarde.",
  ceremonyFailed: "La ceremonia de claves de los custodios no supera la comprobación",
  ceremonyFailedDetail:
    "Falta el registro público de cómo crearon sus claves los custodios de la encuesta, o no supera una comprobación, así que este dispositivo no cifrará tus respuestas para esas claves.",
  whatToDoTitle: "Lo que puedes hacer",
  whatToDoNoteTitle: "Prueba otra dirección",
  whatToDo:
    "Abre la encuesta desde abolishus.eth o desde otra dirección que publique Abolish. Si la comprobación también falla ahí, avísale a quien te pidió que votaras, y no votes hasta que se arregle.",
  // The question screens (questions.tsx); each instruction from the question's limits (answers.ts).
  questionNumber: "Pregunta {number}",
  checkStep: "Revisa tus respuestas",
  chooseOne: "Escoge una.",
  chooseAny: "Escoge todas las que quieras.",
  chooseUpTo: "Escoge hasta {count}.",
  chooseExactly: { one: "Escoge una.", other: "Escoge exactamente {count}." },
  chooseAtLeast: { one: "Escoge al menos una.", other: "Escoge al menos {count}." },
  chooseBetween: "Escoge de {min} a {max}.",
  changeSingle: "Para cambiar tu respuesta, escoge otra.",
  changeMulti: "Para quitar una opción, escógela otra vez.",
  cantSkip: "Esta pregunta no se puede omitir.",
  selected: "Escogida",
  chosenOf: "{count} de {max} escogidas",
  moreAllowed: "Puedes escoger {count} más",
  noMoreAllowed: "No quedan más opciones",
  nothingChosen: "Todavía no has escogido nada.",
  youChose: "Escogiste: {label}.",
  overvoteTitle: "Ya escogiste {count}",
  overvote:
    "Es lo máximo que permite esta pregunta, así que no cambió nada. Para escoger “{label}”, primero quita otra de tus opciones.",
  skipTitle: "¿Omitir esta pregunta?",
  skipExplained:
    "Una pregunta omitida cuenta como sin respuesta. Tus otras respuestas siguen contando, y puedes volver a esta antes de enviar.",
  skipClears: "Al omitirla se borra lo que escogiste aquí.",
  skipAndGoOn: "Omitir y seguir",
  keepAnswering: "Seguir respondiendo",
  skipQuestion: "Omitir esta pregunta",
  shortExactlyTitle: {
    one: "Esta pregunta necesita una respuesta",
    other: "Esta pregunta necesita exactamente {count}",
  },
  shortAtLeastTitle: {
    one: "Esta pregunta necesita al menos una",
    other: "Esta pregunta necesita al menos {count}",
  },
  shortExplained: "Escoge {count} más para seguir.",
  nextQuestion: "Siguiente pregunta",
  toCheck: "Revisar tus respuestas",
  back: "Atrás",
  // Check your answers (questions.tsx).
  checkTitle: "Revisa tus respuestas",
  checkLede: "Todavía no se ha enviado nada. Cambia lo que quieras.",
  answersLabel: "Tus respuestas",
  skippedOne: "Omitiste la pregunta {number}",
  skippedMany: "Omitiste {count} preguntas",
  skippedExplained:
    "Una pregunta omitida cuenta como sin respuesta. Para responderla, usa Cambiar.",
  skippedAnswer: "Omitida: cuenta como sin respuesta",
  unfitOne: "La pregunta {number} necesita una respuesta",
  unfitMany: "{count} preguntas necesitan una respuesta",
  unfitExplained: "Esas preguntas no se pueden omitir. Para responder una, usa Cambiar.",
  change: "Cambiar",
  changeLabel: "Cambiar tu respuesta a la pregunta {number}",
  seal: "Sellar mis respuestas",
  sealExplained:
    "Sellar cifra tus respuestas en este dispositivo. No se envía nada: una vez selladas, escoges si emitirlas o comprobar primero el cifrado.",
  // Finding the voter on the poll's list, then sealing (sealed.tsx).
  findingTitle: "Buscándote en la lista de la encuesta",
  finding:
    "Este dispositivo está leyendo el tablero público de la encuesta para encontrar tu lugar entre sus miembros, sin decirle a nadie cuál eres. No se envía nada.",
  sealingTitle: "Sellando tus respuestas",
  sealing: "Este dispositivo está cifrando tus respuestas. No se envía nada.",
  sealedTitle: "Tus respuestas están selladas",
  sealed:
    "Este dispositivo cifró tus respuestas en una boleta sellada. Solo suficientes custodios de la encuesta, trabajando juntos, podrían abrirla. Todavía no se ha enviado nada.",
  trackingCodeLabel: "Código de seguimiento de tu boleta sellada",
  trackingCodeQr: "Código QR del código de seguimiento {hash}",
  trackingCodeFingerprint: "Huella del código de seguimiento {hash}",
  scanTitle: "Escanéalo ahora con tu otro dispositivo",
  scan: "Si quieres comprobar este dispositivo, escanea el código con otro teléfono o computadora antes de escoger. Ese guarda el código, así que después puede saber si este dispositivo abrió la misma boleta que te mostró.",
  chooseTitle: "Dos formas de seguir",
  cast: "Emitir esta boleta",
  castExplained: "Envía la boleta sellada al tablero público.",
  challenge: "Comprobar primero el cifrado",
  challengeExplained:
    "Abre esta boleta sellada para que tu otro dispositivo pueda mostrar que contiene exactamente lo que escogiste. Una boleta abierta nunca se puede contar, así que después respondes otra vez y sellas una nueva.",
  challengeOptional:
    "Opcional. Que cualquiera compruebe de vez en cuando es lo que descubre a un dispositivo que cambia votos.",
  // A challenged ballot, opened (sealed.tsx).
  openingTitle: "Abriendo tu boleta sellada",
  opening: "Este dispositivo está abriendo la boleta sellada. No se envía nada.",
  openedTitle: "Tu boleta sellada está abierta",
  opened:
    "Este dispositivo abrió la boleta sellada que te mostró. Ya no se puede contar, y no se envió nada.",
  openedCode: "El código de seguimiento que abrió",
  checkElsewhereTitle: "Compruébala en tu otro dispositivo",
  checkElsewhere:
    "Esta pantalla la dibujó el dispositivo que selló la boleta, así que no puede responder por sí mismo. Guarda la apertura y ábrela en el dispositivo que escaneó el código: ese dispositivo compara las dos y muestra lo que contiene la boleta.",
  saveOpening: "Guardar la apertura",
  savedOpeningNote:
    "Guárdala antes de responder otra vez: cuando salgas de esta pantalla ya no se podrá guardar. La apertura muestra cómo respondiste esta vez, así que guárdala para ti y bórrala cuando la hayas comprobado.",
  answerAgainExplained:
    "Tus respuestas no se guardan: respondes otra vez, y este dispositivo las sella de nuevo.",
  // When sealing or opening stopped (sealed.tsx).
  cantSealTitle: "Esta boleta todavía no puede sellar respuestas para esta encuesta",
  cantSealVersion:
    "Esta encuesta es de un tipo anterior que esta versión de la boleta no sella. No se selló ni se envió nada.",
  noIdentityTitle: "Este dispositivo todavía no tiene una identidad de votación",
  noIdentity:
    "Para responder esta encuesta hace falta una identidad de votación guardada en este dispositivo, y esta copia de la boleta no puede crearla y registrarla. No se selló ni se envió nada.",
  identityUnreadableTitle: "No se puede leer la identidad de votación de este dispositivo",
  identityUnreadable:
    "Este navegador no dejó que la boleta la leyera, o lo que guarda no es una identidad de votación. No se selló ni se envió nada. No borres los datos de este sitio: puede que tu identidad siga ahí.",
  unregisteredTitle: "Tu identidad de votación todavía no está registrada",
  unregistered:
    "Este dispositivo guarda una identidad de votación que todavía no está en ninguna lista, y esta copia de la boleta no puede registrarla. No se selló ni se envió nada. No borres los datos de este sitio: la identidad sigue siendo tuya.",
  recoveredCastTitle: "Este dispositivo todavía no puede responder con una identidad recuperada",
  recoveredCast:
    "Tu identidad de votación volvió a este dispositivo desde su copia de seguridad. Antes de responder una encuesta, este dispositivo debe mostrarte cualquier boleta que hayas emitido desde otro dispositivo, y esta versión de la boleta todavía no puede. No se selló ni se envió nada. Responde desde el dispositivo con el que votaste antes, o espera a una versión posterior.",
  notListedTitle: "No estás en la lista de esta encuesta",
  notListed:
    "Esta encuesta está abierta a personas verificadas de otras formas que tu identidad de votación, así que no puedes responderla. No se selló ni se envió nada.",
  boardUnavailableTitle: "No se pudo leer el tablero público de la encuesta",
  boardUnavailable:
    "Este dispositivo lee el tablero entero para encontrar tu lugar en la lista de la encuesta, y esta vez no pudo. Revisa tu conexión y responde otra vez. No se selló ni se envió nada.",
  noRegistrarsTitle:
    "Esta copia de la boleta todavía no puede encontrarte en la lista de una encuesta",
  noRegistrars:
    "Todavía no sabe de quién son las firmas que añaden personas a las listas, así que no puede reconstruir ninguna. No se selló ni se envió nada.",
  cellRefusedTitle: "No se encontró tu lugar en la lista de la encuesta",
  cellRefused:
    "El tablero que leyó este dispositivo no te muestra entre los miembros de esta encuesta, o no supera la comprobación. Puede que un servidor haya enviado un tablero incompleto, o que tu registro todavía no esté en él. Responde otra vez más tarde. No se selló ni se envió nada.",
  sealFailedTitle: "Este dispositivo no pudo sellar tus respuestas",
  sealFailed:
    "No se envió nada. Responde otra vez, o abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  openFailedTitle: "Este dispositivo no pudo abrir la boleta sellada",
  openFailed:
    "La boleta que selló ya no se puede contar, y no se envió nada. Puede que esta copia de la boleta tenga una falla: ábrela desde abolishus.eth o desde otra dirección que publique Abolish.",
  noL1Title: "Esta boleta todavía no puede leer Ethereum",
  noL1: "Cada boleta emitida indica un bloque reciente de Ethereum que este dispositivo lee por su cuenta, y esta versión de la boleta todavía no puede leerlo. Tu boleta no se hizo y no se envió nada.",
  castFailedTitle: "Este dispositivo no pudo hacer tu boleta",
  castFailed:
    "No se envió nada. Responde otra vez, o abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  castFaultyTitle: "Tu boleta no superó la comprobación de este dispositivo",
  castFaulty:
    "Este dispositivo comprueba cada boleta antes de enviarla, y esta estaba mal, así que no se envió. Puede que esta copia de la boleta tenga una falla: ábrela desde abolishus.eth o desde otra dirección que publique Abolish.",
  noDeliveryTitle: "Esta boleta todavía no puede enviar tu boleta",
  noDelivery:
    "Una boleta emitida cuenta solo cuando sus partes llegan a los custodios de la encuesta, y esta versión de la boleta todavía no puede entregarlas por todas las vías que debe. Tu boleta no se hizo y no se envió nada.",
  castsUnreadableTitle: "No se puede leer el registro de tus boletas en este dispositivo",
  castsUnreadable:
    "Este dispositivo guarda un registro de cada boleta que envía, para que una nueva nunca anule una anterior, y ahora no se puede leer. No se envió nada. Comprueba que este navegador guarde los datos de los sitios y responde otra vez.",
  castsUnwritableTitle: "Este dispositivo no pudo registrar tu boleta",
  castsUnwritable:
    "Una boleta se envía solo después de que este dispositivo la registra, para que una nueva nunca la anule, y este navegador rechazó el registro. No se envió nada. Comprueba que este navegador guarde los datos de los sitios y responde otra vez.",
  notNewerTitle: "Espera un momento y responde otra vez",
  notNewer:
    "Tu última boleta desde este dispositivo es tan reciente que una nueva ahora la anularía en vez de reemplazarla. No se envió nada. Responde otra vez en un minuto.",
  // Delivering and sending a cast ballot (sealed.tsx).
  resumingTitle: "Abriendo tu boleta",
  resuming:
    "Este dispositivo está revisando su registro de las boletas que emitió en esta encuesta.",
  unsentEarlierTitle: "Tu última boleta aquí no se envió",
  unsentEarlier:
    "Este dispositivo selló y registró una boleta para esta encuesta, pero el tablero nunca la confirmó. Envíala para terminar de emitirla, o responde otra vez: una boleta nueva la reemplaza.",
  deliveringTitle: "Entregando tu boleta a los custodios de la encuesta",
  delivering:
    "Este dispositivo registró tu boleta sellada y le está dando a cada custodio de la encuesta su parte sellada. Mantén esta página abierta.",
  unsentUndeliveredTitle: "Tu boleta todavía no ha llegado a todos los custodios",
  unsentUndelivered:
    "Una boleta cuenta solo cuando cada custodio de la encuesta tiene su parte sellada, y algunos no tomaron la suya esta vez. Este dispositivo no envió nada al tablero, pero quien pasó las partes todavía podría poner esta boleta ahí, donde reemplazaría tu boleta anterior sin contar. Envíala otra vez en un minuto; si sigue sin pasar, responde otra vez mientras la encuesta esté abierta.",
  sendingTitle: "Enviando tu boleta",
  sending:
    "Este dispositivo registró tu boleta sellada y la está enviando al tablero público. Mantén esta página abierta.",
  sendAgain: "Enviar otra vez",
  sendAgainTitle: "Enviar otra vez es seguro",
  sendAgainExplained:
    "Envía la misma boleta sellada que registró este dispositivo, nunca una nueva, así que no puede contar dos veces ni anularse a sí misma.",
  unsentBusyTitle: "El tablero está ocupado",
  unsentBusy: "Tu boleta todavía no se recibió. Espera un minuto y envíala otra vez.",
  unsentUnavailableTitle: "Puede que tu boleta todavía no esté en el tablero",
  unsentUnavailable:
    "El tablero no respondió a tiempo, así que este dispositivo no puede saber si recibió tu boleta. Envíala otra vez para averiguarlo.",
  unsentUnreachableTitle: "No se pudo enviar tu boleta",
  unsentUnreachable:
    "No se pudo comunicar con el tablero, o su respuesta no es una que este dispositivo lea. Revisa tu conexión y envíala otra vez.",
  unsentUnconfirmedTitle: "La respuesta del tablero no muestra tu boleta",
  unsentUnconfirmed:
    "Respondió con algo distinto de tu boleta, así que este dispositivo no puede saber si la recibió. Envíala otra vez, o más tarde abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  // The posting offer for a ballot some trustees didn't take (posting-offer.tsx).
  checkingPostingTitle: "Comprobando lo que guardó este dispositivo",
  checkingPosting:
    "Antes de darte a escoger, este dispositivo está comprobando que las partes que guardó para estos custodios son las que selló tu boleta.",
  postingOfferTitle: "Algunos custodios no han tomado tu boleta",
  postingOffer: {
    one: "Tu boleta cuenta solo cuando cada custodio de la encuesta tiene su parte sellada, y uno no tomó la suya. Este dispositivo no envió nada al tablero. Escoge qué hacer.",
    other:
      "Tu boleta cuenta solo cuando cada custodio de la encuesta tiene su parte sellada, y {count} no tomaron la suya. Este dispositivo no envió nada al tablero. Escoge qué hacer.",
  },
  postingRetry: "Intentar otra vez con los custodios",
  postingRetryTitle: "Intentar otra vez",
  postingRetryExplained:
    "Este dispositivo les entrega otra vez a los custodios las mismas partes selladas, así que nada cuenta dos veces. Espera un minuto antes.",
  postingPostTitle: "Publicar las partes que faltan en el registro público",
  postingPostExplained:
    "Las partes que faltan van al registro público con la clave de su sello exterior, para que los custodios puedan abrirlas sin haberlas tomado. Tu voto sigue siendo secreto hoy, pero esas partes pierden su protección a largo plazo: quien más adelante rompa el cifrado de hoy podrá leerlas, y si se publican suficientes partes de tu boleta para abrirla, podrá leer tu boleta entera. Esto no se puede deshacer.",
  postingPost: "Publicar en público y después enviar",
  postingDeclineTitle: "Dejar esta boleta",
  postingDeclineExplained:
    "Este dispositivo borra las partes que guardó para estos custodios, y esta boleta no contará. Quien pasó las partes todavía podría ponerla en el tablero, donde reemplazaría tu boleta anterior sin contar, así que responde otra vez mientras la encuesta esté abierta.",
  postingDecline: "Dejar esta boleta",
  postingFailedTitle: "La publicación no se completó",
  postingFailed:
    "No se publicó ni se envió nada al tablero. Intenta publicar otra vez en un minuto, o escoge otra forma.",
  postingRelayedTitle: "La publicación todavía no está en el tablero",
  postingRelayed:
    "Nuestro servicio de publicación, operado por quien administra la encuesta, recibió las partes que faltan con la clave de su sello exterior, así que cuéntalas como publicadas: todavía pueden llegar al registro público, y dejar esta boleta no las puede recuperar. Intenta publicar otra vez en un minuto: se envían las mismas partes, nunca otras nuevas.",
  postingWalletOfferTitle: "Publicar desde tu propia billetera",
  postingWalletOffer:
    "Nuestro servicio de publicación no puso las partes que faltan en el registro público, así que tu propia billetera de Ethereum puede hacerlo, pagando la tarifa de la red. La dirección que paga se publica para siempre junto a esta boleta y a cada nueva respuesta que des en esta encuesta, así que usa una dirección nueva con fondos privados, nunca una ligada a ti o a una cuenta de un intercambio. Tu billetera y el nodo que usa ven las partes que faltan antes que el registro público. Si la red no toma la publicación en diez minutos, tu billetera te pide forzarla a través de Ethereum desde la misma dirección, lo que también necesita ETH ahí y cuesta más. Este dispositivo envía tu boleta solo cuando el registro las muestra.",
  postingWalletPost: "Publicar desde mi billetera y enviar",
  postingHandedTitle: "Las partes que faltan todavía pueden llegar al tablero",
  postingHanded:
    "Este intento o uno anterior entregó las partes que faltan a nuestro servicio de publicación o a tu billetera, así que cuéntalas como publicadas: todavía pueden llegar al registro público, y dejar esta boleta no las puede recuperar.",
  walletSentTitle: "La publicación de tu billetera todavía no está en el tablero",
  walletSent:
    "Tu billetera envió las partes que faltan, o todavía puede enviarlas, así que cuéntalas como publicadas: todavía pueden llegar al registro público, y dejar esta boleta no las puede recuperar. Rechaza cualquier solicitud que siga abierta en tu billetera, espera unos minutos y publica desde tu billetera otra vez: este dispositivo las busca primero, y pide a tu billetera solo lo que no está.",
  walletForcedTitle: "Tu billetera forzó la publicación a través de Ethereum",
  walletForced:
    "La red no tomó a tiempo la publicación de tu billetera, así que tu billetera la envió a través de Ethereum, que la red tiene que incluir. Cuenta las partes que faltan como publicadas: llegan al registro público antes del plazo de entrega de la encuesta, lo que puede tardar algunas horas, y dejar esta boleta no las puede recuperar. Mantén esta página abierta, y no la recargues ni abras esta boleta en otra pestaña: después del plazo de publicación de la encuesta, eso borra lo que este dispositivo guardó para ellas, y tu boleta ya no se puede enviar desde aquí. Publica desde tu billetera otra vez solo cuando el registro ya pueda mostrarlas: este dispositivo las busca primero, y envía tu boleta cuando las encuentra.",
  walletRejectedTitle: "Tu billetera no envió nada",
  walletRejected:
    "Se rechazó una solicitud en tu billetera, así que no se envió nada más desde ella. Si tu billetera ya te había mostrado la publicación, ella y su nodo vieron las partes que faltan. Escoge otra vez abajo.",
  walletRefusedTitle: "El tablero no aceptará esta publicación",
  walletRefused:
    "La comprobación de tu billetera dice que el tablero rechazaría la publicación, así que no se envió nada y no se gastó nada de tu tarifa. Tu billetera y su nodo recibieron las partes que faltan para esa comprobación. Intenta otra vez con los custodios, o deja esta boleta.",
  walletWrongChainTitle: "Tu billetera está en otra red",
  walletWrongChain:
    "Tu billetera no cambió a la red en la que está el tablero de la encuesta, así que esta vez no se envió nada. Cámbiala a esa red y publica desde tu billetera otra vez.",
  walletMissingTitle: "No hay billetera en este navegador",
  walletMissing:
    "Este dispositivo no encontró ninguna billetera de Ethereum a la cual preguntar. Agrega una a este navegador, o abre la boleta en un navegador que tenga una, y publica desde tu billetera otra vez.",
  walletLateTitle: "Ya pasó el tiempo para publicar",
  walletLate:
    "Ya pasó el límite para publicar de la encuesta, así que esta vez no se envió nada desde tu billetera y ya no se puede publicar nada más para esta boleta.",
  walletFailedTitle: "Tu billetera no respondió",
  walletFailed:
    "Tu billetera o su nodo no respondió a tiempo, o respondió con un error. Puede que haya recibido las partes que faltan, así que cuéntalas como entregadas. Rechaza cualquier solicitud que siga abierta en tu billetera y luego intenta otra vez en un minuto.",
  declinedTitle: "Esta boleta no contará",
  declined:
    "Este dispositivo borró las partes que guardó para los custodios que no tomaron la suya. Responde otra vez mientras la encuesta esté abierta: tu nueva boleta reemplaza a esta, y a tu boleta anterior, dondequiera que lleguen al tablero.",
  decliningTitle: "Dejando esta boleta",
  declining: "Este dispositivo está borrando las partes que guardó para esta boleta.",
  postingTitle: "Publicando las partes que faltan",
  posting:
    "Este dispositivo está publicando las partes que faltan y después enviará tu boleta. Mantén esta página abierta.",
  postingWalletTitle: "Publicando desde tu billetera",
  postingWallet:
    "Confirma cada solicitud en tu billetera, también en Ethereum si te pide forzar la publicación. Después este dispositivo espera a que el tablero registre las partes que faltan antes de enviar tu boleta. Mantén esta página abierta.",
  sentTitle: "Tu boleta está en el tablero",
  sent: "El tablero público recibió tu boleta sellada, y este dispositivo comprobó que la respuesta del tablero contiene exactamente la boleta que envió.",
  sentCopy: "El tablero público ya tiene una copia de tu boleta sellada, que vale por la tuya.",
  sentIndex: "Entrada {index} del tablero",
  sentUnsignedTitle: "Lo que comprobó este dispositivo",
  sentUnsigned:
    "La respuesta del tablero todavía no está firmada, así que es solo la palabra del tablero. Más tarde, comprueba desde otro dispositivo que tu código de seguimiento está en el tablero.",
  revoteExplained:
    "Puedes cambiar tus respuestas hasta que cierre la encuesta. Una boleta nueva desde este dispositivo reemplaza a esta.",
  sendRejectedTitle: "El tablero rechazó tu boleta",
  sendRejected:
    "Indicó la comprobación que no superó tu boleta. Puede que esta copia de la boleta tenga una falla: abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  sendRefusedTitle: "El tablero no pudo recibir tu boleta",
  sendRefused:
    "No conoce esta encuesta, o no pudo leer la solicitud. No se contó nada. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  notOpenTitle: "Esta encuesta no está recibiendo boletas",
  notOpen:
    "Según el reloj del tablero, la encuesta todavía no ha abierto o ya cerró, así que no se contó nada.",
  answerConflictTitle: "El tablero dio dos respuestas para una boleta",
  answerConflict:
    "Este dispositivo registró dónde puso el tablero tu boleta, y ahora el tablero dice otro lugar. Repórtalo, con tu código de seguimiento, a quien organiza la encuesta.",
  // Proving membership (proving.tsx); each refusal names the check that stopped it.
  provingTitle: "Probando que puedes responder",
  proving:
    "Este dispositivo está haciendo una prueba de que formas parte de los miembros de esta encuesta, sin mostrar quién eres. Mantén esta página abierta.",
  provingLabel: "Tu prueba",
  provingStarting: "Empezando",
  provingSteps: "{done} de {of} pasos",
  provingLocalTitle: "Hecha en este dispositivo",
  provingLocal:
    "Tu identidad de votación nunca sale de él. La prueba dice solo que estás en la lista de la encuesta, y este dispositivo la comprueba antes de enviar nada.",
  proofCheckTitle: "La comprobación que lo detuvo",
  proofCheckNamed: "Su nombre, para quien reciba tu reporte:",
  proofNothingSent: "Ninguna prueba ni respuesta salió de este dispositivo, y no se contó nada.",
  proofSecretTitle: "No se puede usar la identidad de votación de este dispositivo",
  proofSecret:
    "La identidad que guarda este dispositivo para votar no es válida, así que no se puede hacer ninguna prueba con ella.",
  proofNotMemberTitle: "No estás en la lista de esta encuesta",
  proofNotMember:
    "Tu identidad de votación no está entre los miembros a los que se abrió esta encuesta, así que este dispositivo no puede probar que puedes responderla. Si crees que deberías estar, avísale a quien te pidió que respondieras.",
  proofRootTitle: "La lista de miembros no coincide con la encuesta",
  proofRoot:
    "Los miembros que recibió este dispositivo no forman la lista registrada para esta encuesta, así que puede que un servidor haya enviado una lista equivocada o incompleta. Inténtalo más tarde.",
  proofUnavailableTitle: "No se pudieron obtener los archivos para hacer pruebas",
  proofUnavailable:
    "Esta copia de la boleta no los sirvió. Revisa tu conexión e inténtalo otra vez, o abre la boleta desde otra dirección.",
  proofZkeyTitle: "La clave para hacer pruebas no es la publicada",
  proofZkey:
    "La clave que recibió este dispositivo para hacer pruebas no es la que fija esta versión de la boleta, así que no se usó. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  proofWasmTitle: "La calculadora de la prueba no es la publicada",
  proofWasm:
    "El archivo que recibió este dispositivo para calcular la prueba no es el que fija esta versión de la boleta, así que no se usó. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  proofProverTitle: "La parte que hace las pruebas no respondió bien",
  proofProver:
    "Se detuvo, respondió fuera de turno o tardó demasiado. Puede que esta copia de la boleta tenga una falla: ábrela desde abolishus.eth o desde otra dirección que publique Abolish.",
  proofStoppedTitle: "Este dispositivo se detuvo mientras hacía la prueba",
  proofStopped:
    "La prueba no terminó. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  proofWrongTitle: "La prueba no superó la comprobación de este dispositivo",
  proofWrong:
    "Este dispositivo comprueba cada prueba antes de enviarla, y esta estaba mal. Puede que esta copia de la boleta tenga una falla: ábrela desde abolishus.eth o desde otra dirección que publique Abolish.",
  proofFaultTitle: "Este dispositivo cometió un error al terminar la prueba",
  proofFault:
    "La prueba terminada no superó la propia comprobación de este dispositivo, así que no se envió. Puede que esta copia de la boleta tenga una falla: ábrela desde abolishus.eth o desde otra dirección que publique Abolish.",
  // Registering at Tier 0 (register.tsx).
  makeIdentityTitle: "Crea una identidad de votación en este dispositivo",
  makeIdentity:
    "Para responder esta encuesta, este dispositivo crea una identidad de votación y pide que se añada a la lista de personas que se registraron aquí.",
  makeIdentityStart: "Crear mi identidad de votación",
  registerTitle: "Registra tu identidad de votación",
  register:
    "Este dispositivo guarda una identidad de votación que todavía no está en ninguna lista. Para responder esta encuesta, pide que se añada a la lista de personas que se registraron aquí.",
  registerStart: "Registrarla",
  identityKeptTitle: "Se queda en este dispositivo",
  identityKept:
    "Tu identidad de votación es un número secreto creado y guardado aquí, que nunca se envía a ningún lado. Solo un código calculado a partir de ella va a la lista, y tus respuestas no se pueden vincular con ella.",
  registerStepsTitle: "Lo que pasa después",
  registerSteps:
    "Demuestras que eres una persona en una página de comprobación que opera Cloudflare, y después este dispositivo envía el código. Se añade a la lista en un lote con otros en más o menos una hora, y vuelves para responder.",
  registerPreparingTitle: "Creando tu identidad de votación",
  registerPreparing:
    "Este dispositivo está creando tu identidad de votación y guardándola. No se envía nada.",
  registerSendingTitle: "Enviando tu registro",
  registerSending:
    "Este dispositivo está enviando el código calculado a partir de tu identidad de votación.",
  challengeStepTitle: "Demuestra que eres una persona",
  challengeStep:
    "Resuelve la comprobación de abajo. Cuando la superes, este dispositivo enviará tu registro de inmediato.",
  challengeSeesTitle: "Lo que ve la página de comprobación",
  challengeSees:
    "Funciona en un sitio propio y a este dispositivo solo le entrega un pase. Nunca ve tu identidad de votación, su código ni tus respuestas.",
  registerSentTitle: "Se envió tu registro",
  registerSent:
    "El código de tu identidad de votación está esperando a que lo añadan a la lista. Tu identidad se queda en este dispositivo.",
  registerWaitTitle: "Vuelve en más o menos una hora",
  registerWait:
    "Los registros se añaden por lotes, y un lote puede esperar a que se sumen otros, así que el tuyo puede tardar una hora o más en aparecer. Mientras tanto, no borres los datos de este sitio: tu identidad se guarda solo aquí.",
  backToPoll: "Volver a la encuesta",
  registerWaitingTitle: "Tu registro va en camino",
  registerWaiting:
    "Este dispositivo envió tu registro el {when}. Cuando esté en la lista podrás responder esta encuesta.",
  checkAgain: "Comprobar otra vez",
  registerUnwritableTitle: "Este navegador no guarda una identidad de votación",
  registerUnwritable:
    "Se negó a guardarla, quizás en una ventana privada o con los datos de los sitios bloqueados. No se envió nada. Abre la boleta en una ventana normal para registrarte.",
  registerWorkerFailedTitle: "Este dispositivo no pudo preparar tu registro",
  registerWorkerFailed:
    "No se envió nada. Tu identidad de votación, si se creó, se guarda en este dispositivo. Inténtalo otra vez.",
  challengeRefusedTitle: "La comprobación no se superó",
  challengeRefused:
    "El registro no se aceptó porque el pase de la comprobación se rechazó o venció. No cambió nada. Intenta la comprobación otra vez.",
  registerLaterTitle: "No se pudo enviar tu registro",
  registerLater:
    "El servicio de registro estaba ocupado, no estaba disponible o no se pudo comunicar con él. Tu identidad de votación se guarda en este dispositivo. Inténtalo otra vez en unos minutos.",
  registerFaultyTitle: "El servicio de registro rechazó esta solicitud",
  registerFaulty:
    "Dice que la solicitud no es una que acepte, así que puede que esta copia de la boleta tenga una falla. Tu identidad de votación se guarda en este dispositivo. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  registerNotNotedTitle: "Se envió tu registro, pero este dispositivo no pudo anotarlo",
  registerNotNoted:
    "La identidad de votación de este dispositivo cambió o no se pudo volver a leer, así que puede que se ofrezca registrarla otra vez. No borres los datos de este sitio.",
  registerReadingTitle: "Comprobando tu registro",
  registerReading:
    "Este dispositivo está leyendo la lista pública de registros, entera, para que nadie sepa qué entrada busca.",
  registerDueTitle: "Tu registro todavía no aparece",
  registerDue:
    "Este dispositivo envió tu registro el {when}, y ya debería estar en la lista. Puede que se haya perdido, así que puedes enviarlo otra vez.",
  registerRepeatTitle: "Enviarlo otra vez es seguro",
  registerRepeat:
    "Es el mismo código de la misma identidad de votación, para la misma zona. Si al final se añade el primero, el segundo no cambia nada.",
  registerAgain: "Enviarlo otra vez",
  registerJoinedTitle: "Tu registro está listo",
  registerJoined:
    "El código de tu identidad de votación está en la lista, y este dispositivo lo anotó. Ya puedes responder esta encuesta.",
  registerMovedTitle: "Tu identidad de votación se puso en la lista de otra zona",
  registerMoved:
    "El código de tu identidad de votación está en la lista pública, pero para una zona distinta de la que pidió este dispositivo, así que tus respuestas se contarían allá. No respondas encuestas con ella, y no borres los datos de este sitio.",
  registerMovedWhyTitle: "Por qué esto es grave",
  registerMovedWhy:
    "Alguien más añadió tu código allá antes de que llegara tu propio registro. Eso no se puede deshacer: solo una identidad de votación nueva te devolvería a tu propia zona. Este dispositivo ofrece una nueva solo cuando una segunda fuente de la lista, independiente, muestra lo mismo, porque una sola fuente podría estar equivocada, y solo cuando tu propio registro ha tenido tiempo de llegar, porque contaría primero. Comprueba otra vez dentro de un rato.",
  registerMovedConfirmed:
    "Dos fuentes independientes de la lista pública coinciden: el código de tu identidad de votación está en ella para una zona distinta de la que pidió este dispositivo, así que tus respuestas se contarían allá. No respondas encuestas con ella.",
  registerMovedStartAgain:
    "Eso no se puede deshacer, así que este dispositivo puede crearte una identidad de votación nueva en lugar de esta, que después registras para tu propia zona. La anterior se descarta de este dispositivo. Una copia de seguridad que hayas hecho de ella sigue guardando la anterior hasta que respaldes la nueva.",
  registerStartAgain: "Crear una identidad de votación nueva",
  registerReplacingTitle: "Creando tu nueva identidad de votación",
  registerReplacing:
    "Este dispositivo está leyendo la lista otra vez desde las dos fuentes y comprobando que todavía guarda la identidad que se movió, y después creará una nueva en su lugar. No se envía nada.",
  outcomeDisputedTitle: "Dos fuentes de la lista no coinciden",
  outcomeDisputed:
    "Una fuente mostró tu código en la lista de otra zona, y una segunda fuente, independiente, no mostró lo mismo. Una de ellas está equivocada, así que este dispositivo no cambió nada, y tu identidad de votación se conserva. Inténtalo otra vez en unos minutos.",
  notReplacedTitle: "Tu identidad de votación se conservó",
  notReplaced:
    "La identidad de votación de este dispositivo ya no es la que se movió, o está registrada en un grupo, así que no se reemplazó. No se envió nada. Inténtalo otra vez para comprobar esta encuesta de nuevo.",
  registryUnavailableTitle: "No se pudo comprobar tu registro",
  registryUnavailable:
    "No se pudo leer entera la lista pública de registros, o lo que llegó no era ella. No se envió nada, y tu identidad de votación se guarda en este dispositivo. Inténtalo otra vez en unos minutos.",
  noGroupRegistryTitle: "Esta copia de la boleta no puede comprobar registros",
  noGroupRegistry:
    "No sabe dónde se guarda la lista pública de registros. Tu registro se envió y tu identidad de votación se guarda en este dispositivo. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  regionChangedTitle: "Esta copia de la boleta atiende otra zona",
  regionChanged:
    "Tu registro pidió una zona en la que esta copia de la boleta ya no registra personas, así que aquí no lo comprobará ni lo volverá a enviar. Tu identidad de votación se guarda en este dispositivo. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  joinNotNotedTitle: "Tu registro está listo, pero este dispositivo no pudo anotarlo",
  joinNotNoted:
    "La identidad de votación de este dispositivo cambió o no se pudo escribir. No se envió nada. Inténtalo otra vez: la lista se lee de nuevo.",
  // Backing up the voting identity with a passkey (backup-offer.tsx).
  backupOfferTitle: "¿Hacer una copia de seguridad con una llave de acceso?",
  backupOffer:
    "Para que tu identidad de votación no se pierda con este dispositivo: se guarda una copia sellada que solo abre tu llave de acceso.",
  backupStart: "Hacer una copia con una llave de acceso",
  backupSkip: "Ahora no",
  backupSkipMeans:
    "Si la omites, igual puedes responder en este dispositivo. Un dispositivo nuevo empezaría como alguien nuevo. Tus comprobantes se quedan en este dispositivo de todas formas.",
  backupSectionTitle: "Copia de seguridad con llave de acceso",
  backupSkipped:
    "Sin copia de seguridad por ahora. Puedes seguir respondiendo en este dispositivo.",
  backupWorking:
    "Sigue las indicaciones de llave de acceso de tu navegador. Este dispositivo sella tu identidad de votación con la llave de acceso y después guarda la copia sellada.",
  backupStoredTitle: "Copia hecha con tu llave de acceso",
  backupStored:
    "Se guardó una copia sellada de tu identidad de votación, y solo tu llave de acceso la abre. Tus comprobantes se quedan en este dispositivo.",
  backupNoSyncTitle: "Esta llave de acceso no se puede copiar a tus otros dispositivos",
  backupNoSync:
    "La copia de seguridad se guardó, pero la llave de acceso que la abre vive solo en este dispositivo o llave de seguridad, así que se pierde con ellos. No borres los datos de este sitio.",
  backupNotSyncedTitle: "Tu llave de acceso todavía no está en tus otros dispositivos",
  backupNotSynced:
    "La copia de seguridad se guardó, pero hasta que tu app de llaves de acceso copie la llave, perder este dispositivo también la perdería. Comprueba otra vez cuando tus dispositivos se hayan sincronizado.",
  backupCheckSync: "Comprobar otra vez",
  backupRetry: "Intentar otra vez",
  backupUnreadableTitle: "No hay ninguna identidad de votación que respaldar",
  backupUnreadable:
    "Este dispositivo no pudo leer una identidad de votación ni el registro de su copia, así que no se respaldó nada. No borres los datos de este sitio.",
  backupUnwritableTitle: "Este navegador no guarda el registro de la copia",
  backupUnwritable:
    "Se negó a guardar qué llave de acceso tiene la copia, quizás en una ventana privada o con los datos de los sitios bloqueados, así que no se respaldó nada. Abre la boleta en una ventana normal para hacer la copia.",
  backupCancelledTitle: "Se cerró la ventana de la llave de acceso",
  backupCancelled: "No se respaldó nada. Inténtalo otra vez cuando quieras.",
  backupUnsupportedTitle: "Esta llave de acceso no puede guardar una copia",
  backupUnsupported:
    "Tu navegador o tu app de llaves de acceso no admite lo que necesita la copia, así que no se guardó nada. Puedes seguir respondiendo en este dispositivo. Para hacer la copia, prueba otro navegador u otra app de llaves de acceso.",
  backupNoUvTitle: "La llave de acceso no comprobó que fueras tú",
  backupNoUv:
    "Una copia necesita que tu llave de acceso pida tu huella digital, tu cara, tu PIN o el bloqueo de pantalla, y esta no lo hizo, así que no se guardó nada. Inténtalo otra vez, o usa otra app de llaves de acceso.",
  backupFailedTitle: "La copia no terminó",
  backupFailed: "Algo en este dispositivo la detuvo, y no se respaldó nada. Inténtalo otra vez.",
  backupRejectedTitle: "El servicio de copias rechazó esta copia",
  backupRejected:
    "Dice que la copia sellada no es una que acepte, así que puede que esta copia de la boleta tenga una falla. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  backupUnreachableTitle: "No se pudo guardar la copia",
  backupUnreachable:
    "El servicio de copias no estaba disponible o no se pudo comunicar con él. Tu identidad de votación sigue en este dispositivo. Inténtalo otra vez en unos minutos.",
  backupNotKeptTitle: "El servicio de copias no conservó la copia",
  backupNotKept:
    "Aceptó la copia sellada pero no la devolvió cuando este dispositivo la comprobó, así que no cuenta como respaldada. Inténtalo otra vez.",
  // Recovering the voting identity on a new device (recover.tsx).
  recoverOfferTitle: "¿Creaste una en otro dispositivo?",
  recoverOffer:
    "Si hiciste una copia de tu identidad de votación con una llave de acceso, recupérala aquí en vez de crear una nueva.",
  recoverOfferStart: "Recuperarla con una llave de acceso",
  recoverTitle: "Recupera tu identidad de votación",
  recover:
    "Tu navegador pide la llave de acceso con la que hiciste la copia. Este dispositivo obtiene la copia sellada, la abre con la llave de acceso y comprueba que tu identidad está en una lista pública antes de guardarla.",
  recoverStart: "Usar mi llave de acceso",
  recoverKeptTitle: "Se abre solo en este dispositivo",
  recoverKept:
    "Tu identidad de votación llega sellada y se abre aquí, nunca en otro lugar. El servicio de copias ve solo un código de tu llave de acceso, y la lista pública se lee entera, así que ningún servidor sabe qué identidad es la tuya.",
  recoverLeftTitle: "Lo que no se recupera",
  recoverLeft:
    "Los comprobantes y el registro de cómo respondiste se quedan en el dispositivo que usaste antes. Un dispositivo que ya tiene una identidad de votación no puede recuperar otra.",
  recoverWorkingTitle: "Recuperando tu identidad de votación",
  recoverWorking:
    "Sigue las indicaciones de llave de acceso de tu navegador. Después, este dispositivo obtiene la copia sellada, la abre y comprueba la lista pública. No se envía nada sobre tu identidad ni tus respuestas.",
  recoveredTitle: "Tu identidad de votación está en este dispositivo",
  recovered:
    "Se abrió, y la lista pública la cuenta en la zona {region}. Desde ahora la guarda este dispositivo.",
  recoveredAreaTitle: "Revisa la zona",
  recoveredArea:
    "Si la zona {region} no es donde te registraste, puede que alguien haya movido tu identidad antes de que la recuperaras. No respondas encuestas con ella, y no borres los datos de este sitio.",
  recoveredOneDeviceTitle: "Responde cada encuesta desde un solo dispositivo",
  recoveredOneDevice:
    "Tu llave de acceso puede llevar esta identidad a más de un dispositivo. Dos dispositivos que responden la misma encuesta sin los registros del otro pueden anular tu voto, así que usa solo uno por encuesta.",
  recoveredNoSync:
    "Tu identidad volvió, pero la llave de acceso que abre su copia vive solo en este dispositivo o llave de seguridad, así que la copia se pierde con ellos.",
  recoveredNotSynced:
    "Tu identidad volvió, pero hasta que tu app de llaves de acceso copie la llave, perder este dispositivo también perdería la copia.",
  recoverOther: "Probar otra llave de acceso",
  recoverUnreadable:
    "Este navegador no dejó que la boleta leyera lo que guarda, así que no se recuperó nada encima. No borres los datos de este sitio: puede que tu identidad siga ahí.",
  recoverCancelledTitle: "Se cerró la ventana de la llave de acceso",
  recoverCancelled: "No se recuperó nada. Inténtalo otra vez cuando quieras.",
  recoverUnsupportedTitle: "Esta llave de acceso no puede abrir una copia",
  recoverUnsupported:
    "Tu navegador o tu app de llaves de acceso no admite lo que necesita la copia. Prueba la llave de acceso desde otra app de llaves de acceso, u otro navegador.",
  recoverNoUv:
    "Abrir una copia necesita que tu llave de acceso pida tu huella digital, tu cara, tu PIN o el bloqueo de pantalla, y esta no lo hizo, así que no se recuperó nada. Inténtalo otra vez.",
  recoverFailedTitle: "La recuperación no terminó",
  recoverFailed: "Algo en este dispositivo la detuvo, y no se recuperó nada. Inténtalo otra vez.",
  recoverUnreachableTitle: "No se pudo obtener la copia",
  recoverUnreachable:
    "El servicio de copias no estaba disponible o no se pudo comunicar con él, y no se recuperó nada. Inténtalo otra vez en unos minutos.",
  recoverNoBackupTitle: "No hay copia para esta llave de acceso",
  recoverNoBackup:
    "El servicio de copias no tiene nada para la llave de acceso que escogiste. Si tienes otra llave de acceso para esta boleta, prueba con esa.",
  recoverDamagedTitle: "Esta copia no se puede abrir",
  recoverDamaged:
    "Lo que devolvió el servicio de copias no se abre con esta llave de acceso, así que no se recuperó nada. Si tienes otra llave de acceso para esta boleta, prueba con esa.",
  recoverRegistryTitle: "No se pudo comprobar tu identidad",
  recoverRegistry:
    "No se pudo leer entera la lista pública de registros, o lo que llegó no era ella, así que no se guardó nada. Inténtalo otra vez en unos minutos.",
  recoverNoGroupRegistryTitle: "Esta copia de la boleta no puede comprobar registros",
  recoverNoGroupRegistry:
    "No sabe dónde se guarda la lista pública de registros, así que no puede recuperar una identidad. Abre la boleta desde abolishus.eth o desde otra dirección que publique Abolish.",
  recoverNotRegisteredTitle: "Tu identidad todavía no está en una lista",
  recoverNotRegistered:
    "La copia se abrió, pero ninguna lista que lea esta boleta cuenta su identidad, así que no se guardó nada. Un registro enviado en las últimas horas puede que todavía no se haya añadido: inténtalo más tarde.",
  recoverUnwritableTitle: "Este navegador no guarda una identidad de votación",
  recoverUnwritable:
    "Se negó a guardarla, quizás en una ventana privada o con los datos de los sitios bloqueados, así que no se recuperó nada. Abre la boleta en una ventana normal para recuperarla.",
};
