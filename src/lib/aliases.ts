/**
 * Built-in names for ~140 common shop items (kirana, general, dairy, stationery, medical counter): Hindi, English and the usual Roman spellings.
 * A product picks up an entry's aliases when its Hindi or English name (or one of its words)
 * sounds like any form of that entry (same phonetic key), so "Tata नमक" also answers to "salt".
 * Shopkeepers can add their own per product (Product.aliases).
 */
import { phoneticKey } from "./translit";

export const KIRANA_ALIASES: readonly (readonly string[])[] = [
  // staples
  ["चीनी", "sugar", "chini", "cheeni", "shakkar", "shakar", "शक्कर"],
  ["नमक", "salt", "namak", "nimak", "lavan"],
  ["आटा", "atta", "aata", "wheat flour", "gehu ka atta", "गेहूं आटा"],
  ["मैदा", "maida", "refined flour", "all purpose flour"],
  ["सूजी", "suji", "sooji", "rava", "rawa", "semolina", "रवा"],
  ["बेसन", "besan", "gram flour", "chickpea flour"],
  ["चावल", "rice", "chawal", "chaawal", "basmati", "बासमती"],
  ["पोहा", "poha", "chivda", "flattened rice", "चिवड़ा"],
  ["दलिया", "daliya", "dalia", "broken wheat", "porridge"],
  ["साबूदाना", "sabudana", "sago", "tapioca"],
  // dals
  ["दाल", "dal", "daal", "dhal", "lentil", "lentils", "pulses"],
  ["अरहर दाल", "arhar dal", "toor dal", "tur dal", "tuvar", "तूर दाल", "pigeon pea"],
  ["मूंग दाल", "moong dal", "mung dal", "moong", "मूंग"],
  ["मसूर दाल", "masoor dal", "masur", "red lentil", "मसूर"],
  ["उड़द दाल", "urad dal", "udad", "urad", "उड़द", "black gram"],
  ["चना दाल", "chana dal", "chane ki dal"],
  ["चना", "chana", "channa", "chickpea", "chole", "छोले", "kabuli chana"],
  ["राजमा", "rajma", "kidney beans"],
  ["लोबिया", "lobia", "lobhia", "black eyed peas"],
  // oils & fats
  ["तेल", "oil", "tel", "cooking oil"],
  ["सरसों तेल", "mustard oil", "sarson tel", "sarso ka tel", "kadwa tel"],
  ["रिफाइंड तेल", "refined oil", "refined", "soyabean oil", "sunflower oil"],
  ["घी", "ghee", "ghi", "desi ghee", "देसी घी"],
  ["डालडा", "dalda", "vanaspati", "वनस्पति"],
  ["नारियल तेल", "coconut oil", "nariyal tel", "parachute"],
  // spices
  ["हल्दी", "haldi", "turmeric", "haldee"],
  ["मिर्च", "mirch", "mirchi", "chilli", "chili", "lal mirch", "लाल मिर्च", "red chilli", "मिर्ची"],
  ["धनिया", "dhaniya", "dhania", "coriander", "dhaniya powder"],
  ["जीरा", "jeera", "zeera", "jira", "cumin"],
  ["राई", "rai", "sarson dana", "mustard seeds"],
  ["मेथी", "methi", "fenugreek"],
  ["अजवाइन", "ajwain", "ajwayan", "carom"],
  ["सौंफ", "saunf", "sonf", "fennel"],
  ["इलायची", "elaichi", "ilaychi", "ilaichi", "cardamom"],
  ["लौंग", "laung", "long", "clove", "cloves"],
  ["दालचीनी", "dalchini", "cinnamon"],
  ["काली मिर्च", "kali mirch", "black pepper", "pepper"],
  ["हींग", "hing", "heeng", "asafoetida"],
  ["गरम मसाला", "garam masala", "masala", "मसाला"],
  ["तेज पत्ता", "tej patta", "bay leaf"],
  ["इमली", "imli", "tamarind"],
  ["अमचूर", "amchur", "aamchur", "mango powder"],
  // tea, sugar-side, dairy
  ["चाय पत्ती", "chai patti", "chai", "tea", "चाय", "tea leaves", "chaipatti"],
  ["कॉफ़ी", "coffee", "kaafi", "kofi", "nescafe"],
  ["दूध", "doodh", "dudh", "milk"],
  ["दही", "dahi", "curd", "yogurt", "yoghurt"],
  ["पनीर", "paneer", "panir", "cottage cheese"],
  ["मक्खन", "makkhan", "makhan", "butter", "amul butter"],
  ["छाछ", "chhach", "chaach", "buttermilk", "mattha"],
  ["गुड़", "gud", "gur", "jaggery"],
  ["शहद", "shahad", "honey"],
  ["अंडे", "ande", "anda", "egg", "eggs", "अंडा"],
  ["ब्रेड", "bread", "double roti", "pav"],
  // packaged
  ["मैगी", "maggi", "maggie", "noodles", "नूडल्स"],
  ["बिस्कुट", "biscuit", "biscuits", "biskut", "parle g", "पारले"],
  ["नमकीन", "namkeen", "mixture", "bhujia", "भुजिया"],
  ["चिप्स", "chips", "kurkure", "lays"],
  ["टोस्ट", "toast", "rusk", "रस्क"],
  ["सॉस", "sauce", "ketchup", "kechup", "केचप"],
  ["अचार", "achar", "aachar", "pickle"],
  ["पापड़", "papad", "papadum"],
  ["कोल्ड ड्रिंक", "cold drink", "coke", "pepsi", "thanda", "ठंडा"],
  ["पानी की बोतल", "water bottle", "pani", "bisleri", "पानी"],
  ["जूस", "juice", "frooti", "maaza"],
  ["चॉकलेट", "chocolate", "chocolet", "toffee", "टॉफ़ी", "dairy milk"],
  // dry fruits
  ["काजू", "kaju", "cashew"],
  ["बादाम", "badam", "almond", "almonds"],
  ["किशमिश", "kishmish", "raisins", "kismis"],
  ["मूंगफली", "moongfali", "mungfali", "peanut", "peanuts", "groundnut"],
  ["मखाना", "makhana", "fox nut"],
  ["नारियल", "nariyal", "coconut", "gola"],
  // household
  ["साबुन", "sabun", "soap", "nahane ka sabun"],
  ["कपड़े धोने का साबुन", "kapde dhone ka sabun", "washing soap", "detergent bar", "rin"],
  ["सर्फ़", "surf", "detergent", "washing powder", "sarf", "nirma", "wheel"],
  ["शैम्पू", "shampoo", "shampu", "shampo"],
  ["टूथपेस्ट", "toothpaste", "paste", "colgate", "manjan", "मंजन"],
  ["टूथब्रश", "toothbrush", "brush", "ब्रश"],
  ["तेल बालों का", "hair oil", "balon ka tel"],
  ["माचिस", "machis", "matchis", "matchbox", "match box", "matches"],
  ["अगरबत्ती", "agarbatti", "agarbati", "incense", "dhoop", "धूप"],
  ["मोमबत्ती", "mombatti", "candle", "candles"],
  ["झाड़ू", "jhadu", "jhaadu", "broom"],
  ["पोछा", "pocha", "pochha", "mop"],
  ["बर्तन साबुन", "bartan sabun", "vim", "dishwash", "bartan dhone ka sabun"],
  ["फिनाइल", "phenyl", "finail", "floor cleaner"],
  ["बल्ब", "bulb", "balb", "led"],
  ["बैटरी", "battery", "cell", "सेल"],
  ["कॉपी", "copy", "notebook", "kapi"],
  ["पेन", "pen", "kalam", "कलम"],
  ["सैनिटरी पैड", "sanitary pad", "pads", "whisper", "stayfree"],
  ["डायपर", "diaper", "diapers", "pampers"],
  ["क्रीम", "cream", "kreem", "fair and lovely"],
  ["पाउडर", "powder", "talc", "pauder"],
  ["मच्छर अगरबत्ती", "machhar agarbatti", "mosquito coil", "good knight", "kachhua", "कछुआ"],
  ["थैली", "thaili", "polythene", "bag", "carry bag", "पन्नी"],
  // vegetables often sold at kirana counters
  ["प्याज़", "pyaz", "pyaaz", "onion", "kanda", "कांदा"],
  ["आलू", "aloo", "alu", "potato", "potatoes"],
  ["टमाटर", "tamatar", "tomato", "tomatoes"],
  ["लहसुन", "lahsun", "lehsun", "garlic"],
  ["अदरक", "adrak", "ginger"],
  ["नींबू", "nimbu", "neembu", "lemon", "lime"],
  ["हरी मिर्च", "hari mirch", "green chilli"],
  ["भिंडी", "bhindi", "okra", "lady finger"],
  ["फूल गोभी", "phool gobhi", "gobhi", "cauliflower", "गोभी"],
  ["पत्ता गोभी", "patta gobhi", "cabbage", "band gobhi"],
  ["बैंगन", "baingan", "brinjal", "eggplant"],
  ["गाजर", "gajar", "carrot", "carrots"],
  ["खीरा", "kheera", "khira", "cucumber"],
  ["केला", "kela", "banana", "bananas"],
  ["सेब", "seb", "apple", "apples"],
  // dairy counter
  ["लस्सी", "lassi", "sweet lassi"],
  ["खोया", "khoya", "mawa", "मावा"],
  ["आइसक्रीम", "ice cream", "icecream", "kulfi", "कुल्फी"],
  // stationery
  ["पेंसिल", "pencil", "pensil"],
  ["रबर", "rubber", "eraser"],
  ["स्केल", "scale", "ruler"],
  ["गोंद", "gond", "glue", "fevicol"],
  ["रजिस्टर", "register", "rajistar"],
  ["लिफ़ाफ़ा", "lifafa", "envelope", "लिफाफा"],
  // medical counter (common over-the-counter items)
  ["बुखार की गोली", "paracetamol", "crocin", "dolo", "calpol", "पैरासिटामोल"],
  ["दर्द की गोली", "pain killer", "painkiller", "combiflam", "dard ki goli"],
  ["खांसी की दवा", "cough syrup", "khansi ki dawai", "benadryl", "कफ़ सिरप"],
  ["ओआरएस", "ors", "electral", "oral rehydration"],
  ["बैंडेज", "bandage", "band aid", "bandaid", "बैंड एड"],
  ["रुई", "rui", "cotton", "cotton wool"],
  ["डेटॉल", "dettol", "antiseptic", "savlon"],
  ["बाम", "balm", "vicks", "zandu balm", "विक्स"],
  ["गैस की दवा", "eno", "antacid", "digene", "ईनो"],
  ["विटामिन", "vitamin", "multivitamin", "becosules"],
  ["थर्मामीटर", "thermometer", "tharmameter", "bukhar napne ka"],
  ["मास्क", "mask", "face mask"],
  ["सैनिटाइज़र", "sanitizer", "sanitiser", "hand sanitizer"],
];

interface AliasEntry {
  forms: readonly string[];
  keys: Set<string>;
}

let ENTRIES: AliasEntry[] | null = null;
const entries = () =>
  (ENTRIES ??= KIRANA_ALIASES.map((forms) => ({ forms, keys: new Set(forms.map(phoneticKey).filter(Boolean)) })));

/**
 * Built-in aliases for a product name pair: every entry whose form sounds like the full Hindi or
 * English name, or like one of their words (e.g. "Tata नमक" -> salt / namak).
 */
export function builtinAliases(nameHi: string, nameEn: string): string[] {
  const keys = new Set<string>();
  for (const n of [nameHi, nameEn]) {
    const k = phoneticKey(n);
    if (!k) continue;
    keys.add(k);
    for (const w of k.split(" ")) if (w.length >= 2) keys.add(w);
  }
  const out = new Set<string>();
  for (const e of entries()) {
    let hit = false;
    for (const k of e.keys) if (keys.has(k)) hit = true;
    if (hit) for (const f of e.forms) out.add(f);
  }
  return [...out];
}

/** Clean a comma / newline separated alias list from the product form. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n،;]+/)) {
    const a = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    const k = a.toLowerCase();
    if (a && !seen.has(k)) {
      seen.add(k);
      out.push(a);
    }
    if (out.length >= 20) break;
  }
  return out;
}
