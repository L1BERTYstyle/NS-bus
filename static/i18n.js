'use strict';
/* Языки интерфейса: русский (ru) и сербский латиницей (sr). Названия остановок не переводятся. */
const LANG = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ru' || q === 'sr') { try { localStorage.setItem('nsbus.lang', q); } catch (e) { /* */ } return q; }
  const s = localStorage.getItem('nsbus.lang');
  if (s === 'ru' || s === 'sr') return s;
  return /^(sr|hr|bs|sh|me)/i.test(navigator.language || '') ? 'sr' : 'ru';
})();
const LOCALE = LANG === 'sr' ? 'sr-Latn-RS' : 'ru-RU';

const I18N = {
  ru: {
    now: 'сейчас', min: 'мин', h: 'ч', m: 'м', km: 'км',
    stopF: ['остановка', 'остановки', 'остановок'], busF: ['автобус', 'автобуса', 'автобусов'],
    attrMap: 'Карта © Google · Данные NSmart / JGSP Novi Sad', attrSat: 'Снимки © Google · Данные NSmart / JGSP Novi Sad',
    attrTraffic: 'Карта и пробки © Google · Данные NSmart / JGSP Novi Sad', attrOsm: '© OpenStreetMap · Данные NSmart / JGSP Novi Sad',
    routeTo: 'Маршрут сюда', routeFrom: 'Маршрут отсюда', collapse: 'Свернуть ▴', more: 'Подробнее ▾',
    restored: 'трасса восстановлена', changed: 'трасса изменена (ремонт)', until: 'до', source: 'Источник',
    trafficChanges: 'Изменения в движении', newsSub: 'Новости JGSP «Novi Sad» (gspns.co.rs) · ремонты и изменения трасс',
    routeChanges: 'Изменения трасс', important: 'Важное', inactive: 'уже не действует', read: 'Читать', openOn: 'Открыть на',
    noNews: 'Новостей нет или сайт gspns.co.rs недоступен.', back: 'Назад', appTitle: 'Автобусы Нови-Сада',
    homeSub: (a, b) => `${a} линий · ${b} остановок · онлайн-данные NSmart`, changedShort: 'Изменение трассы',
    howToGetBtn: 'Как добраться? Выбрать точку на карте', andMore: (n) => `и ещё ${n}…`, nearby: 'Остановки рядом',
    homeNote: 'Нажмите на остановку на карте, найдите её через поиск или выберите номер автобуса ниже. Кнопка ◎ покажет ближайшие к вам остановки.',
    cityLines: 'Городские линии', suburbanLines: 'Пригородные линии', intercityLines: 'Междугородные (от автовокзала)',
    noArrivals: 'Сейчас к этой остановке автобусов не ожидается.', online: 'онлайн', onWay: 'в пути',
    schedNotOut: 'по расписанию (ещё не вышел на линию)', stopWord: 'остановка', loadingArr: 'Загружаю прибытия…',
    linesOfStop: 'Линии этой остановки', nextBuses: 'Ближайшие автобусы', updated: 'Обновлено', updatedL: 'обновлено',
    autoRefresh: 'автообновление каждые 15 с', fetchFail: 'Не удалось получить данные', searchingBuses: 'ищу автобусы на линии…',
    line: 'Линия', lineNote: 'Время у остановок — оценка по положению автобусов (≈). Точное время прибытия — нажмите на остановку.',
    onLine: 'на линии', noOnline: 'сейчас нет автобусов онлайн', noNsmart: 'нет связи с NSmart', wholeLine: 'Вся линия',
    bySchedule: 'по расписанию', busNo: 'автобус', stopWordCap: 'Остановка',
    tripNote: 'Время для выбранной остановки — прогноз NSmart; для остальных — оценка (≈) по скорости автобуса.',
    tripEnded: 'Автобус завершил рейс или пропал из данных NSmart', A: 'А', B: 'Б', stopAbbr: 'ост.', pointNear: 'Точка у',
    myLocation: 'Моё местоположение', tapMap: 'Нажмите на карту…', from: 'Откуда', to: 'Куда', picking: 'выбираю…', onMap: 'на карте',
    howToGet: 'Как добраться', swap: 'Поменять', fromMe: 'От меня', tapTo: 'Нажмите на карте, куда вам нужно',
    tapFrom: 'Нажмите на карте, откуда вы едете', in: 'через', noTrips: 'ближайших рейсов NSmart не показывает', wait: 'ожидание',
    optimal: 'Оптимальный', noTransfers: 'Без пересадок', noTransfersL: 'без пересадок', arrival: 'прибытие', fromStop: 'от ост.',
    walkL: 'пешком', walkC: 'Пешком', transfer: 'пересадка', leaveIn: 'выходите через', leaveNow: 'выходите сейчас',
    possibleChange: 'возможное изменение трассы (ремонт)', toStop: 'до остановки', toDest: 'до места назначения', or: 'или',
    towards: 'в сторону', nextOnes: 'следующие', unverifiedT: 'Направление не подтверждено живыми данными',
    unverified: 'порядок остановок по схеме', midStops: 'Промежуточные остановки', exit: 'Выход', board: 'Посадка', arrived: 'Вы на месте',
    planHintTo: '👉 Нажмите на карте место, <b>куда</b> вам нужно (или долгое нажатие / правый клик → «Маршрут сюда»).',
    planHintFrom: '👉 Укажите на карте, <b>откуда</b> поедете, или нажмите «От меня».', flagsDrag: 'Флажки А и Б можно перетаскивать.',
    searchingPlan: 'Ищу варианты маршрута…', planFail: 'Не удалось построить маршрут', walkFaster: 'Пешком быстрее',
    noOptions: 'Автобусных вариантов не найдено. Попробуйте передвинуть флажки ближе к остановкам.', options: 'Варианты',
    details: 'Подробно: вариант', onThisRoute: 'На этом маршруте',
    planNote: 'Ожидание — живые данные NSmart (●), если автобус уже на линии, иначе — оценка. Пешие участки проложены по улицам (OpenStreetMap). Время в пути примерное.',
    busC: 'Автобус', nothingFound: 'Ничего не найдено', geoNA: 'Геолокация недоступна в этом браузере',
    geoHttps: 'Браузер разрешает геолокацию только по https или на localhost (см. README)', youHere: 'Вы здесь',
    geoFail: 'Не удалось определить местоположение', loadingNet: 'Загружаю сеть маршрутов NSmart…', loadErr: 'Ошибка загрузки',
    retry: 'повтор…', loadFail: 'Не удалось загрузить данные. Проверьте, что server.py запущен и есть интернет.',
    translated: 'Переведено с сербского автоматически (Google Translate)', walkOnly: 'Только пешком',
    docTitle: 'NS Bus — автобусы Нови-Сада', searchPh: 'Остановка или номер автобуса', clear: 'Очистить',
    routeBtn: 'Маршрут на автобусе', layersBtn: 'Тип карты', locateBtn: 'Где я', layerMap: 'Схема (Google)',
    layerTraffic: 'Пробки и перекрытия (Google)', layerSat: 'Спутник (Google)', language: 'Язык',
  },
  sr: {
    now: 'sada', min: 'min', h: 'h', m: 'm', km: 'km',
    stopF: ['stanica', 'stanice', 'stanica'], busF: ['autobus', 'autobusa', 'autobusa'],
    attrMap: 'Mapa © Google · Podaci NSmart / JGSP Novi Sad', attrSat: 'Snimci © Google · Podaci NSmart / JGSP Novi Sad',
    attrTraffic: 'Mapa i saobraćaj © Google · Podaci NSmart / JGSP Novi Sad', attrOsm: '© OpenStreetMap · Podaci NSmart / JGSP Novi Sad',
    routeTo: 'Ruta dovde', routeFrom: 'Ruta odavde', collapse: 'Skupi ▴', more: 'Detaljnije ▾',
    restored: 'trasa vraćena na redovnu', changed: 'izmenjena trasa (radovi)', until: 'do', source: 'Izvor',
    trafficChanges: 'Izmene u saobraćaju', newsSub: 'Vesti JGSP „Novi Sad“ (gspns.co.rs) · radovi i izmene trasa',
    routeChanges: 'Izmene trasa', important: 'Važno', inactive: 'više ne važi', read: 'Pročitaj', openOn: 'Otvori na',
    noNews: 'Nema vesti ili sajt gspns.co.rs nije dostupan.', back: 'Nazad', appTitle: 'Autobusi Novog Sada',
    homeSub: (a, b) => `${a} linija · ${b} stanica · NSmart podaci uživo`, changedShort: 'Izmena trase',
    howToGetBtn: 'Kako stići? Izaberite tačku na mapi', andMore: (n) => `i još ${n}…`, nearby: 'Stanice u blizini',
    homeNote: 'Dodirnite stanicu na mapi, pronađite je pretragom ili izaberite broj linije ispod. Dugme ◎ prikazuje stanice najbliže vama.',
    cityLines: 'Gradske linije', suburbanLines: 'Prigradske linije', intercityLines: 'Međumesne (sa autobuske stanice)',
    noArrivals: 'Trenutno se na ovoj stanici ne očekuju autobusi.', online: 'uživo', onWay: 'u vožnji',
    schedNotOut: 'po redu vožnje (još nije krenuo)', stopWord: 'stanica', loadingArr: 'Učitavam dolaske…',
    linesOfStop: 'Linije ove stanice', nextBuses: 'Najbliži autobusi', updated: 'Ažurirano', updatedL: 'ažurirano',
    autoRefresh: 'automatsko osvežavanje na 15 s', fetchFail: 'Nije moguće preuzeti podatke', searchingBuses: 'tražim autobuse na liniji…',
    line: 'Linija', lineNote: 'Vremena kod stanica su procena prema položaju autobusa (≈). Za tačno vreme dolaska dodirnite stanicu.',
    onLine: 'na liniji', noOnline: 'trenutno nema autobusa uživo', noNsmart: 'nema veze sa NSmart', wholeLine: 'Cela linija',
    bySchedule: 'po redu vožnje', busNo: 'autobus', stopWordCap: 'Stanica',
    tripNote: 'Vreme za izabranu stanicu je NSmart prognoza; za ostale je procena (≈) prema brzini autobusa.',
    tripEnded: 'Autobus je završio vožnju ili je nestao iz NSmart podataka', A: 'A', B: 'B', stopAbbr: 'st.', pointNear: 'Tačka kod',
    myLocation: 'Moja lokacija', tapMap: 'Dodirnite mapu…', from: 'Odakle', to: 'Dokle', picking: 'biram…', onMap: 'na mapi',
    howToGet: 'Kako stići', swap: 'Zameni', fromMe: 'Od mene', tapTo: 'Dodirnite na mapi gde želite da stignete',
    tapFrom: 'Dodirnite na mapi odakle polazite', in: 'za', noTrips: 'NSmart ne prikazuje najbliže polaske', wait: 'čekanje',
    optimal: 'Optimalno', noTransfers: 'Bez presedanja', noTransfersL: 'bez presedanja', arrival: 'dolazak', fromStop: 'sa st.',
    walkL: 'pešice', walkC: 'Pešice', transfer: 'presedanje', leaveIn: 'krenite za', leaveNow: 'krenite odmah',
    possibleChange: 'moguća izmena trase (radovi)', toStop: 'do stanice', toDest: 'do odredišta', or: 'ili',
    towards: 'u smeru', nextOnes: 'sledeći', unverifiedT: 'Smer nije potvrđen podacima uživo',
    unverified: 'redosled stanica prema šemi', midStops: 'Usputne stanice', exit: 'Izlaz', board: 'Ulaz', arrived: 'Stigli ste',
    planHintTo: '👉 Dodirnite na mapi mesto <b>gde</b> želite da stignete (ili dugi pritisak / desni klik → „Ruta dovde“).',
    planHintFrom: '👉 Označite na mapi <b>odakle</b> polazite ili pritisnite „Od mene“.', flagsDrag: 'Zastavice A i B možete prevlačiti.',
    searchingPlan: 'Tražim varijante putovanja…', planFail: 'Nije moguće izračunati rutu', walkFaster: 'Pešice je brže',
    noOptions: 'Nema autobuskih varijanti. Pokušajte da pomerite zastavice bliže stanicama.', options: 'Varijante',
    details: 'Detaljno: varijanta', onThisRoute: 'Na ovoj ruti',
    planNote: 'Čekanje je prema NSmart podacima uživo (●) ako je autobus već na liniji, inače je procena. Pešačke deonice idu ulicama (OpenStreetMap). Vreme vožnje je približno.',
    busC: 'Autobus', nothingFound: 'Ništa nije pronađeno', geoNA: 'Geolokacija nije dostupna u ovom pregledaču',
    geoHttps: 'Pregledač dozvoljava geolokaciju samo preko https ili na localhost (vidi README)', youHere: 'Vi ste ovde',
    geoFail: 'Nije moguće odrediti lokaciju', loadingNet: 'Učitavam mrežu linija NSmart…', loadErr: 'Greška pri učitavanju',
    retry: 'ponovo…', loadFail: 'Podaci nisu učitani. Proverite da li server radi i da li ima interneta.',
    translated: '', walkOnly: 'Samo pešice',
    docTitle: 'NS Bus — autobusi Novog Sada', searchPh: 'Stanica ili broj linije', clear: 'Obriši',
    routeBtn: 'Ruta autobusom', layersBtn: 'Tip mape', locateBtn: 'Gde sam', layerMap: 'Mapa (Google)',
    layerTraffic: 'Gužve i zatvoreni putevi (Google)', layerSat: 'Satelit (Google)', language: 'Jezik',
  },
};

function t(key, ...args) {
  const v = I18N[LANG][key] ?? I18N.ru[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}
/** Склонение: 1 остановка, 2 остановки, 5 остановок (в сербском то же правило). */
function plural(n, key) {
  const f = t(key + 'F'), a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return f[0];
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return f[1];
  return f[2];
}
function setLang(l) {
  if (l === LANG) return;
  try { localStorage.setItem('nsbus.lang', l); } catch (e) { /* */ }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}
// статические тексты в index.html
document.documentElement.lang = LANG === 'sr' ? 'sr-Latn' : 'ru';
document.title = t('docTitle');
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (b) { e.preventDefault(); e.stopPropagation(); setLang(b.dataset.lang); }
}, true);
const langSwitch = () => `<span class="lang-sw">${['ru', 'sr'].map((l) => `<button data-lang="${l}" class="${l === LANG ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</span>`;
