/**
 * Testi dell'interfaccia, in italiano e inglese.
 *
 * Il viewer gira anche dentro un iframe su morenoise.it, che è bilingue: la
 * lingua arriva da `?lang=`, così la pagina inglese non si ritrova un HUD in
 * italiano. Fuori dall'iframe vale la lingua del browser, con l'italiano come
 * ultima spiaggia.
 *
 * Le emoji e i simboli (🏁 ⚔ 🔻 🥇, P, %, ↗) restano nei template: sono
 * struttura, non testo, e non cambiano da una lingua all'altra.
 */

export type Lang = "it" | "en";

const STRINGS: Record<Lang, Record<string, string>> = {
  it: {
    // Barra dei controlli.
    "controls.fullView": "Vista completa",
    "controls.directorOn": "Regia ON",
    "controls.directorOff": "Regia OFF",
    "controls.track": "Circuito",
    "controls.labelsOn": "Etichette ON",
    "controls.labelsOff": "Etichette OFF",
    "controls.soundOn": "Audio ON",
    "controls.soundOff": "Audio OFF",
    "controls.stocks": "Titoli",
    "controls.openAccount": "Apri conto",

    // Classifica.
    "leaderboard.title": "CLASSIFICA",
    "leaderboard.toggle": "Comprimi/espandi la classifica",
    "leaderboard.invest": "Investi su {sym}",

    // Pannello di selezione dei titoli.
    "selector.title": "TITOLI IN GARA",

    // Stato della sessione e podio.
    "hud.pre": "PRE-GARA · apertura mercati",
    "hud.live": "LIVE · {elapsed} / {total}",
    "hud.done": "TRAGUARDO · gara conclusa",
    "hud.demo": "DEMO · mercato chiuso",
    "hud.demoUntil": "DEMO · mercato chiuso, live da {when}",
    "hud.leading": "in testa",
    "hud.fromLeader": "dal leader",
    "hud.investShort": "Investi ↗",
    "hud.resultTitle": "🏁 RISULTATO DI GIORNATA",
    "hud.laps": "{n} giri",
    "hud.dotd": "Driver of the Day",
    "hud.overtakes": "{n} sorpassi",
    "hud.invest": "Investi su {sym} ↗",
    "hud.podiumDisclaimer":
      "Link sponsorizzati. Le azioni/CFD comportano rischi. Non è consulenza finanziaria.",

    // Radio di gara.
    "radio.newLeader": "🏁 {sym} è la nuova vetta!",
    "radio.battle": "⚔ Lotta in pista: {list}",
    "radio.overtake": "🔻 {sym} sorpassa{on} per la P{pos}!",
    "radio.overtakeOn": " su {sym}",
    "radio.rising": "📈 {sym} vola, ora {pct}%",
    "radio.falling": "📉 {sym} perde colpi, ora {pct}%",

    // Nota di conformità per le CTA sponsorizzate.
    "disclaimer.affiliate":
      "I link a eToro sono sponsorizzati. Le azioni/CFD comportano rischi di perdita del capitale. Non è consulenza finanziaria.",
  },

  en: {
    "controls.fullView": "Full view",
    "controls.directorOn": "Director ON",
    "controls.directorOff": "Director OFF",
    "controls.track": "Circuit",
    "controls.labelsOn": "Labels ON",
    "controls.labelsOff": "Labels OFF",
    "controls.soundOn": "Sound ON",
    "controls.soundOff": "Sound OFF",
    "controls.stocks": "Stocks",
    "controls.openAccount": "Open account",

    "leaderboard.title": "STANDINGS",
    "leaderboard.toggle": "Collapse/expand the standings",
    "leaderboard.invest": "Invest in {sym}",

    "selector.title": "STOCKS ON THE GRID",

    "hud.pre": "PRE-RACE · waiting for the open",
    "hud.live": "LIVE · {elapsed} / {total}",
    "hud.done": "CHEQUERED FLAG · race over",
    "hud.demo": "DEMO · market closed",
    "hud.demoUntil": "DEMO · market closed, live from {when}",
    "hud.leading": "leading",
    "hud.fromLeader": "to leader",
    "hud.investShort": "Invest ↗",
    "hud.resultTitle": "🏁 RESULT OF THE DAY",
    "hud.laps": "{n} laps",
    "hud.dotd": "Driver of the Day",
    "hud.overtakes": "{n} overtakes",
    "hud.invest": "Invest in {sym} ↗",
    "hud.podiumDisclaimer":
      "Sponsored links. Stocks/CFDs carry risk. This is not financial advice.",

    "radio.newLeader": "🏁 {sym} takes the lead!",
    "radio.battle": "⚔ Fight on track: {list}",
    "radio.overtake": "🔻 {sym} overtakes{on} for P{pos}!",
    "radio.overtakeOn": " {sym}",
    "radio.rising": "📈 {sym} is flying, now {pct}%",
    "radio.falling": "📉 {sym} is fading, now {pct}%",

    "disclaimer.affiliate":
      "eToro links are sponsored. Stocks/CFDs carry a risk of capital loss. This is not financial advice.",
  },
};

let current: Lang = "it";

function isLang(value: string | null | undefined): value is Lang {
  return value === "it" || value === "en";
}

/**
 * Decide la lingua e la applica a `<html lang>`, che è quello che leggono gli
 * screen reader e i correttori del browser. Ordine: `?lang=` (lo passa l'iframe
 * del sito), poi la lingua del browser, poi l'italiano.
 */
export function resolveLang(params: URLSearchParams): Lang {
  const fromUrl = params.get("lang");
  if (isLang(fromUrl)) current = fromUrl;
  else {
    const browser = navigator.language?.slice(0, 2).toLowerCase();
    current = isLang(browser) ? browser : "it";
  }
  document.documentElement.lang = current;
  return current;
}

export function lang(): Lang {
  return current;
}

/**
 * Testo tradotto, con i segnaposto `{nome}` sostituiti. Una chiave mancante
 * torna com'è invece di svuotare l'interfaccia: si vede subito, e non rompe.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = STRINGS[current][key] ?? STRINGS.it[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
