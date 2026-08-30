/**
 * Fashion vocabulary for the Indian market.
 *
 * Used in three places, which is why it lives in one file:
 *   1. the heuristic parser (the always-available fallback, ADR-5)
 *   2. feed normalisation during ingestion
 *   3. facet labels in the UI
 *
 * Keys are canonical values stored in the database. Arrays are the surface forms
 * users and merchant feeds actually write.
 */

export const CATEGORIES: Record<string, string[]> = {
  dresses: ['dress', 'dresses', 'midi dress', 'maxi dress', 'mini dress', 'bodycon', 'shift dress', 'wrap dress', 'slip dress', 'gown'],
  tops: ['top', 'tops', 'blouse top', 'crop top', 'tank top', 'camisole', 'cami', 'tube top', 'peplum'],
  shirts: ['shirt', 'shirts', 'button down', 'button-down', 'oxford shirt', 'formal shirt'],
  tshirts: [
    'tshirt',
    'tshirts',
    't-shirt',
    't-shirts',
    't shirt',
    't shirts',
    'tee',
    'tees',
    'graphic tee',
    'polo',
    'polos',
    'rugby polo',
    'jersey',
    'jerseys',
  ],
  kurtas: ['kurta', 'kurtas', 'kurti', 'kurtis', 'tunic'],
  'kurta-sets': ['kurta set', 'kurta sets', 'kurta with palazzo', 'suit set', 'salwar suit', 'churidar set', 'anarkali'],
  sarees: ['saree', 'sarees', 'sari', 'saris', 'organza saree', 'silk saree'],
  lehengas: ['lehenga', 'lehengas', 'lehnga', 'ghagra', 'chaniya choli', 'lehenga choli'],
  'co-ord-sets': ['co-ord', 'coord', 'co ord', 'coord set', 'co-ord set', 'coordinated set', 'matching set', 'two piece', 'twin set'],
  jumpsuits: ['jumpsuit', 'jumpsuits', 'playsuit', 'romper', 'dungaree'],
  skirts: ['skirt', 'skirts', 'midi skirt', 'maxi skirt', 'pencil skirt', 'pleated skirt'],
  trousers: ['trouser', 'trousers', 'pants', 'wide leg', 'wide-leg', 'palazzo', 'palazzos', 'culottes', 'chinos', 'formal pants'],
  jeans: ['jeans', 'denim pants', 'mom jeans', 'boyfriend jeans', 'straight jeans', 'skinny jeans'],
  shorts: ['shorts', 'denim shorts', 'bermuda'],
  blazers: ['blazer', 'blazers', 'suit jacket'],
  jackets: ['jacket', 'jackets', 'denim jacket', 'bomber', 'windcheater', 'overshirt', 'shacket'],
  sweaters: ['sweater', 'sweaters', 'pullover', 'pullovers', 'cardigan', 'jumper', 'knitwear'],
  sweatshirts: ['sweatshirt', 'sweatshirts', 'hoodie', 'hoodies'],
  blouses: ['blouse', 'blouses', 'saree blouse', 'choli'],
  dupattas: ['dupatta', 'dupattas', 'stole', 'odhni'],
  loungewear: ['loungewear', 'pyjama', 'pyjamas', 'pajama', 'pajamas', 'nightwear', 'sleepwear', 'night suit', 'co-ord pyjama', 'robe'],
  activewear: ['activewear', 'gym wear', 'workout', 'sports bra', 'leggings', 'tights', 'joggers', 'track pants'],
  swimwear: ['swimwear', 'swimsuit', 'bikini', 'monokini', 'beachwear', 'cover up'],
  lingerie: ['lingerie', 'bra', 'bralette', 'innerwear', 'shapewear', 'briefs', 'boxer', 'boxers'],
  socks: ['sock', 'socks'],
  sneakers: ['sneaker', 'sneakers', 'trainers', 'canvas shoes', 'chunky sneakers'],
  heels: ['heel', 'heels', 'kitten heel', 'kitten heels', 'stiletto', 'block heel', 'pumps', 'wedges'],
  flats: ['flat', 'flats', 'ballerina', 'ballet flats', 'loafers', 'mojari', 'juttis', 'kolhapuri', 'clog', 'clogs'],
  sandals: ['sandal', 'sandals', 'slides', 'flip flops', 'chappal', 'mules'],
  boots: ['boot', 'boots', 'ankle boots', 'chelsea boots', 'combat boots'],
  bags: ['bag', 'bags', 'handbag', 'tote', 'sling bag', 'crossbody', 'backpack', 'backpacks', 'shoulder bag', 'baguette bag', 'toiletry kit'],
  clutches: ['clutch', 'clutches', 'potli', 'evening bag'],
  jewellery: ['jewellery', 'jewelry', 'earring', 'earrings', 'necklace', 'jhumka', 'jhumkas', 'choker', 'bangle', 'bracelet', 'anklet', 'ring', 'maang tikka', 'lapel pin', 'lapel pins'],
  hats: ['hat', 'hats', 'cap', 'caps'],
  umbrellas: ['umbrella', 'umbrellas'],
  scarves: ['scarf', 'scarves', 'bandana'],
  belts: ['belt', 'belts'],
  sunglasses: ['sunglasses', 'shades', 'sunnies', 'eyewear'],
  watches: ['watch', 'watches'],
};

/** Categories that pair well together, for the "what goes with X" intent (U4). */
export const COMPLEMENTS: Record<string, string[]> = {
  trousers: ['tops', 'shirts', 'blazers', 'heels', 'flats'],
  jeans: ['tops', 'tshirts', 'shirts', 'sneakers', 'jackets'],
  skirts: ['tops', 'shirts', 'heels', 'blazers'],
  sarees: ['blouses', 'jewellery', 'clutches', 'heels'],
  lehengas: ['blouses', 'jewellery', 'clutches', 'dupattas'],
  kurtas: ['trousers', 'dupattas', 'flats', 'jewellery'],
  dresses: ['heels', 'jackets', 'bags', 'jewellery'],
  blazers: ['trousers', 'shirts', 'heels'],
  tops: ['trousers', 'jeans', 'skirts'],
  shirts: ['trousers', 'jeans', 'skirts'],
  tshirts: ['jeans', 'shorts', 'sneakers'],
  shorts: ['tshirts', 'tops', 'sneakers', 'sandals'],
  sweaters: ['jeans', 'trousers', 'boots'],
};

export const COLORS: Record<string, string[]> = {
  black: ['black', 'jet black', 'onyx'],
  white: ['white', 'off white', 'off-white', 'optic white'],
  ivory: ['ivory', 'cream', 'eggshell', 'bone'],
  beige: ['beige', 'nude', 'sand', 'oatmeal', 'ecru'],
  brown: ['brown', 'chocolate', 'coffee', 'mocha'],
  tan: ['tan', 'camel', 'cognac', 'toffee'],
  grey: ['grey', 'gray', 'heather grey', 'silver grey'],
  charcoal: ['charcoal', 'graphite', 'slate'],
  navy: ['navy', 'navy blue', 'midnight blue', 'ink blue'],
  blue: ['blue', 'cobalt', 'royal blue', 'denim blue', 'powder blue', 'sky blue', 'baby blue'],
  teal: ['teal', 'turquoise', 'aqua', 'cyan'],
  green: ['green', 'bottle green', 'forest green', 'kelly green'],
  olive: ['olive', 'olive green', 'khaki', 'army green'],
  sage: ['sage', 'sage green', 'pistachio', 'mint'],
  emerald: ['emerald', 'emerald green', 'jade'],
  yellow: ['yellow', 'lemon', 'butter', 'canary'],
  mustard: ['mustard', 'ochre', 'turmeric', 'haldi yellow'],
  gold: ['gold', 'golden', 'antique gold'],
  orange: ['orange', 'tangerine', 'apricot'],
  rust: ['rust', 'terracotta', 'brick', 'burnt orange'],
  peach: ['peach', 'salmon'],
  coral: ['coral'],
  red: ['red', 'scarlet', 'cherry red', 'crimson'],
  maroon: ['maroon', 'oxblood'],
  burgundy: ['burgundy', 'wine', 'merlot'],
  pink: ['pink', 'rose pink', 'hot pink'],
  blush: ['blush', 'blush pink', 'dusty pink', 'rose'],
  fuchsia: ['fuchsia', 'magenta', 'rani pink'],
  purple: ['purple', 'violet', 'plum', 'aubergine'],
  lavender: ['lavender', 'lilac', 'mauve', 'periwinkle'],
  silver: ['silver', 'metallic silver'],
  multicolour: ['multicolour', 'multicolor', 'multi', 'rainbow', 'colourblock', 'colorblock'],
};

export const MATERIALS: Record<string, string[]> = {
  cotton: ['cotton', 'pure cotton', 'cotton blend', 'poplin', 'cambric', 'voile'],
  linen: ['linen', 'linen blend', 'flax'],
  silk: ['silk', 'pure silk', 'raw silk', 'tussar', 'mulberry silk', 'banarasi'],
  satin: ['satin', 'sateen'],
  chiffon: ['chiffon'],
  georgette: ['georgette'],
  crepe: ['crepe', 'crepe blend'],
  rayon: ['rayon', 'viscose', 'modal', 'tencel', 'lyocell', 'bemberg'],
  denim: ['denim', 'jean fabric'],
  wool: ['wool', 'merino', 'woollen'],
  cashmere: ['cashmere', 'pashmina'],
  velvet: ['velvet', 'velour'],
  leather: ['leather', 'genuine leather'],
  'faux-leather': ['faux leather', 'vegan leather', 'pu leather', 'leatherette'],
  knit: ['knit', 'knitted', 'jersey', 'ribbed'],
  organza: ['organza'],
  tulle: ['tulle', 'net', 'mesh'],
  khadi: ['khadi', 'handloom', 'handspun'],
  chanderi: ['chanderi', 'maheshwari', 'kota', 'kota doria'],
  muslin: ['muslin', 'mulmul'],
  corduroy: ['corduroy', 'cord'],
  polyester: ['polyester', 'poly', 'synthetic'],
  spandex: ['spandex', 'elastane', 'lycra', 'stretch'],
};

export const OCCASIONS: Record<string, string[]> = {
  wedding: ['wedding', 'shaadi', 'bridal', 'bride', 'wedding guest', 'baraat'],
  mehendi: ['mehendi', 'mehndi', 'haldi'],
  sangeet: ['sangeet', 'cocktail sangeet'],
  reception: ['reception', 'engagement', 'roka'],
  festive: ['festive', 'festival', 'diwali', 'navratri', 'eid', 'onam', 'pongal', 'durga puja', 'karwa chauth', 'raksha bandhan'],
  party: ['party', 'night out', 'clubbing', 'birthday party', 'house party'],
  cocktail: ['cocktail', 'cocktail party', 'black tie'],
  brunch: ['brunch', 'day out', 'lunch'],
  work: ['work', 'office', 'workwear', 'formal', 'corporate', 'business casual', 'interview', 'presentation'],
  casual: ['casual', 'everyday', 'daily wear', 'weekend', 'errands'],
  vacation: ['vacation', 'holiday', 'trip', 'getaway', 'goa', 'beach', 'resort', 'poolside', 'honeymoon'],
  travel: ['travel', 'flight', 'airport', 'road trip'],
  'date-night': ['date', 'date night', 'dinner date', 'romantic dinner', 'anniversary'],
  dinner: ['dinner', 'dinner party', 'restaurant'],
  college: ['college', 'campus', 'university', 'class'],
  gym: ['gym', 'workout', 'yoga', 'pilates', 'running', 'training'],
  lounge: ['lounge', 'home', 'wfh', 'work from home', 'chilling'],
  summer: ['summer', 'hot weather', 'heat', 'humid', '25°c', '30°c', '35°c', '40°c'],
  monsoon: ['monsoon', 'rain', 'rainy', 'humid weather'],
  winter: ['winter', 'cold', 'chilly', 'layering'],
};

export const STYLES: Record<string, string[]> = {
  minimal: ['minimal', 'minimalist', 'clean', 'understated', 'simple', 'no fuss'],
  'quiet-luxury': ['quiet luxury', 'old money', 'stealth wealth', 'expensive looking', 'timeless', 'refined', 'elevated basics'],
  boho: ['boho', 'bohemian', 'hippie', 'free spirited', 'festival wear'],
  streetwear: ['streetwear', 'street style', 'urban', 'hypebeast'],
  y2k: ['y2k', '2000s', 'low rise'],
  coquette: ['coquette', 'balletcore', 'bows', 'girly', 'feminine'],
  edgy: ['edgy', 'grunge', 'punk', 'goth', 'rock'],
  romantic: ['romantic', 'floral', 'soft', 'dreamy', 'whimsical'],
  preppy: ['preppy', 'ivy', 'collegiate'],
  athleisure: ['athleisure', 'sporty', 'sport luxe'],
  oversized: ['oversized', 'baggy', 'loose', 'relaxed fit', 'boxy'],
  fitted: ['fitted', 'bodycon', 'tight', 'slim fit', 'body hugging'],
  cropped: ['cropped', 'crop', 'short length'],
  flowy: ['flowy', 'flowing', 'breezy', 'airy', 'drapey', 'floaty'],
  structured: ['structured', 'tailored', 'sharp', 'crisp'],
  vintage: ['vintage', 'retro', 'thrifted', 'old school'],
  sustainable: ['sustainable', 'eco', 'organic', 'ethical', 'slow fashion', 'conscious'],
  'indo-western': ['indo western', 'indo-western', 'fusion'],
  traditional: ['traditional', 'ethnic', 'classic indian', 'desi'],
  contemporary: ['contemporary', 'modern', 'trendy'],
  'modest': ['modest', 'full sleeve', 'covered', 'high neck', 'long sleeve'],
  'breathable': ['breathable', 'sweat free', 'not sweaty', 'cooling', 'lightweight'],
};

export const GENDER_TERMS: Record<string, string[]> = {
  women: ['women', 'womens', "women's", 'woman', 'ladies', 'female', 'girl', 'girls', 'her', 'she'],
  men: ['men', 'mens', "men's", 'man', 'male', 'boy', 'boys', 'him', 'he', 'guys'],
  kids: ['kids', 'kid', 'children', 'child', 'baby', 'toddler', 'infant'],
  unisex: ['unisex', 'gender neutral', 'genderless'],
};

export const ALPHA_SIZES = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '3xl', '4xl', '5xl'];

/** Price band buckets for facets, in paise. */
export const PRICE_BANDS: { value: string; label: string; min: number; max: number | null }[] = [
  { value: 'under-1000', label: 'Under ₹1,000', min: 0, max: 100_000 },
  { value: '1000-2000', label: '₹1,000 – ₹2,000', min: 100_000, max: 200_000 },
  { value: '2000-3500', label: '₹2,000 – ₹3,500', min: 200_000, max: 350_000 },
  { value: '3500-5000', label: '₹3,500 – ₹5,000', min: 350_000, max: 500_000 },
  { value: '5000-10000', label: '₹5,000 – ₹10,000', min: 500_000, max: 1_000_000 },
  { value: 'over-10000', label: 'Over ₹10,000', min: 1_000_000, max: null },
];

// ---------------------------------------------------------------- reverse index

/** Build surface-form → canonical map, longest form first so "kurta set" wins over "kurta". */
function buildIndex(dict: Record<string, string[]>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [canonical, forms] of Object.entries(dict)) {
    pairs.push([canonical.replace(/-/g, ' '), canonical]);
    for (const form of forms) pairs.push([form.toLowerCase(), canonical]);
  }
  // Longest surface form first — critical for correct multi-word matching.
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

export const CATEGORY_INDEX = buildIndex(CATEGORIES);
export const COLOR_INDEX = buildIndex(COLORS);
export const MATERIAL_INDEX = buildIndex(MATERIALS);
export const OCCASION_INDEX = buildIndex(OCCASIONS);
export const STYLE_INDEX = buildIndex(STYLES);
export const GENDER_INDEX = buildIndex(GENDER_TERMS);

export const ALL_CATEGORIES = Object.keys(CATEGORIES);
export const ALL_COLORS = Object.keys(COLORS);
export const ALL_MATERIALS = Object.keys(MATERIALS);
export const ALL_OCCASIONS = Object.keys(OCCASIONS);
export const ALL_STYLES = Object.keys(STYLES);

/** Human label for a canonical token: "co-ord-sets" → "Co-ord sets". */
export function label(canonical: string): string {
  const s = canonical.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Find canonical tokens present in a haystack, matching on word boundaries so
 * "tan" does not match "instant" and "s" does not match every word.
 */
export function matchTokens(haystack: string, index: [string, string][]): string[] {
  const hay = ' ' + haystack.toLowerCase().replace(/[^\p{L}\p{N}°\s-]/gu, ' ').replace(/\s+/g, ' ') + ' ';
  const found: string[] = [];
  for (const [surface, canonical] of index) {
    if (found.includes(canonical)) continue;
    if (hay.includes(' ' + surface + ' ')) found.push(canonical);
  }
  return found;
}
