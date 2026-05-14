// Plan de Prestations Pilotes Long-Courrier AF — 1er avril au 31 octobre 2026.
// Source : CSV "Plan de prestations pilote s26.csv" (389 lignes).
//
// Clé : "${num4d}:${dep}" — ex: "0918:CDG" pour le AF918 CDG→BZV.
// dej = MH Déjeuner servi à bord → pas d'IR créneau 11-15h pendant le TSVP.
// din = MH Dîner servi à bord    → pas d'IR créneau 18-22h pendant le TSVP.
//
// Seules les lignes avec au moins un MH Dej ou MH Din sont incluses.
// Données extraites de la colonne description (col 13) du CSV.

export interface FlightMealProvision {
  dej: boolean;
  din: boolean;
}

const PP: Record<string, FlightMealProvision> = {
  // AF 1–12 (JFK/CDG)
  '0001:JFK': { dej: false, din: true  },
  '0002:CDG': { dej: true,  din: false },
  '0003:JFK': { dej: false, din: true  },
  '0004:CDG': { dej: true,  din: false },
  '0005:JFK': { dej: false, din: true  },
  '0006:CDG': { dej: true,  din: false },
  '0007:JFK': { dej: false, din: true  },
  '0008:CDG': { dej: false, din: true  },
  '0010:CDG': { dej: false, din: true  },
  '0012:CDG': { dej: false, din: true  },
  // AF 18–29 (CDG ↔ LAX/PPT)
  '0018:CDG': { dej: false, din: true  },
  '0019:LAX': { dej: false, din: true  },
  '0019:PPT': { dej: true,  din: false },
  '0020:CDG': { dej: true,  din: false },
  '0021:LAX': { dej: true,  din: false },
  '0022:CDG': { dej: true,  din: false },
  '0023:LAX': { dej: false, din: true  },
  '0024:CDG': { dej: true,  din: false },
  '0025:LAX': { dej: false, din: true  },
  '0026:CDG': { dej: false, din: true  },
  '0027:LAX': { dej: false, din: true  },
  '0027:PPT': { dej: true,  din: false },
  '0028:CDG': { dej: false, din: true  },
  '0029:PPT': { dej: true,  din: false },
  '0029:LAX': { dej: false, din: true  },
  // AF 30–35 (CDG ↔ ATL)
  '0030:CDG': { dej: true,  din: false },
  '0031:ATL': { dej: false, din: true  },
  '0032:CDG': { dej: true,  din: false },
  '0033:ATL': { dej: false, din: true  },
  '0034:CDG': { dej: false, din: true  },
  // AF 50–53 (CDG ↔ IAD)
  '0050:CDG': { dej: true,  din: false },
  '0051:IAD': { dej: false, din: true  },
  '0052:CDG': { dej: false, din: true  },
  '0053:IAD': { dej: false, din: true  },
  // AF 56–57 (CDG ↔ LAS)
  '0056:CDG': { dej: true,  din: false },
  '0057:LAS': { dej: false, din: true  },
  // AF 58–59 (CDG ↔ DEN)
  '0058:CDG': { dej: true,  din: false },
  '0059:DEN': { dej: false, din: true  },
  // AF 62–65 (CDG ↔ EWR)
  '0062:CDG': { dej: true,  din: false },
  '0063:EWR': { dej: false, din: true  },
  '0064:CDG': { dej: false, din: true  },
  // AF 68–69 (CDG ↔ PHX)
  '0068:CDG': { dej: true,  din: false },
  '0069:PHX': { dej: false, din: true  },
  // AF 74–75 (CDG ↔ RDU)
  '0074:CDG': { dej: true,  din: false },
  '0075:RDU': { dej: false, din: true  },
  // AF 81–84 (CDG ↔ SFO)
  '0081:SFO': { dej: false, din: true  },
  '0082:CDG': { dej: false, din: true  },
  '0083:SFO': { dej: true,  din: false },
  '0084:CDG': { dej: true,  din: false },
  // AF 88–89 (CDG ↔ MSP)
  '0088:CDG': { dej: false, din: true  },
  '0089:MSP': { dej: false, din: true  },
  // AF 90–93 (CDG ↔ MIA)
  '0090:CDG': { dej: true,  din: false },
  '0091:MIA': { dej: false, din: true  },
  '0092:CDG': { dej: false, din: true  },
  // AF 96 (CDG → MCO)
  '0096:CDG': { dej: false, din: true  },
  // AF 98–99 (CDG ↔ IAH)
  '0098:CDG': { dej: true,  din: false },
  '0099:IAH': { dej: false, din: true  },
  // AF 111, 116 (CDG ↔ PVG)
  '0111:PVG': { dej: true,  din: true  },
  '0116:CDG': { dej: false, din: true  },
  // AF 132 (CDG → LOS)
  '0132:CDG': { dej: false, din: true  },
  // AF 136–137 (CDG ↔ ORD)
  '0136:CDG': { dej: true,  din: false },
  '0137:ORD': { dej: false, din: true  },
  // AF 158–159 (CDG ↔ DFW)
  '0158:CDG': { dej: true,  din: false },
  '0159:DFW': { dej: false, din: true  },
  // AF 173–179 (CDG ↔ MEX)
  '0173:MEX': { dej: false, din: true  },
  '0174:CDG': { dej: false, din: true  },
  '0178:CDG': { dej: true,  din: false },
  '0179:MEX': { dej: false, din: true  },
  // AF 181–182 (CDG ↔ SIN via 787)
  '0181:SIN': { dej: true,  din: true  },
  '0182:CDG': { dej: true,  din: false },
  // AF 185–188 (CDG ↔ HKG/HND)
  '0185:HKG': { dej: false, din: true  },
  '0186:CDG': { dej: true,  din: false },
  '0187:HND': { dej: true,  din: true  },
  '0188:CDG': { dej: false, din: true  },
  // AF 191, 194 (CDG ↔ BLR)
  '0191:BLR': { dej: true,  din: false },
  '0194:CDG': { dej: true,  din: false },
  // AF 198–199 (CDG ↔ BKK)
  '0198:CDG': { dej: false, din: true  },
  '0199:BKK': { dej: true,  din: false },
  // AF 201–202 (CDG ↔ PEK)
  '0201:PEK': { dej: false, din: true  },
  '0202:CDG': { dej: false, din: true  },
  // AF 217–218 (CDG ↔ BOM)
  '0217:BOM': { dej: true,  din: false },
  '0218:CDG': { dej: true,  din: false },
  // AF 225–226 (CDG ↔ DEL)
  '0225:DEL': { dej: true,  din: false },
  '0226:CDG': { dej: true,  din: false },
  // AF 253, 258 (CDG ↔ SGN)
  '0253:SGN': { dej: true,  din: false },
  '0258:CDG': { dej: true,  din: false },
  // AF 256–257 (CDG ↔ SIN via 777)
  '0256:CDG': { dej: false, din: true  },
  '0257:SIN': { dej: false, din: true  },
  // AF 264, 267 (CDG ↔ ICN)
  '0264:CDG': { dej: true,  din: false },
  '0267:ICN': { dej: true,  din: true  },
  // AF 274, 286–287, 291–293 (CDG ↔ HND/KIX)
  '0274:CDG': { dej: false, din: true  },
  '0286:CDG': { dej: true,  din: false },
  '0287:HND': { dej: true,  din: true  },
  '0291:KIX': { dej: true,  din: true  },
  '0292:CDG': { dej: true,  din: false },
  '0293:HND': { dej: true,  din: true  },
  // AF 327–328 (CDG ↔ YOW)
  '0327:YOW': { dej: false, din: true  },
  '0328:CDG': { dej: true,  din: false },
  // AF 331–334 (CDG ↔ BOS)
  '0331:BOS': { dej: false, din: true  },
  '0332:CDG': { dej: false, din: true  },
  '0333:BOS': { dej: false, din: true  },
  '0334:CDG': { dej: true,  din: false },
  // AF 337–338 (CDG ↔ SEA)
  '0337:SEA': { dej: true,  din: false },
  '0338:CDG': { dej: true,  din: false },
  // AF 342–349 (CDG ↔ YUL)
  '0342:CDG': { dej: true,  din: false },
  '0343:YUL': { dej: false, din: true  },
  '0344:CDG': { dej: true,  din: false },
  '0345:YUL': { dej: false, din: true  },
  '0346:CDG': { dej: false, din: true  },
  '0347:YUL': { dej: false, din: true  },
  '0348:CDG': { dej: false, din: true  },
  // AF 352 (CDG → YQB)
  '0352:CDG': { dej: false, din: true  },
  // AF 356–357 (CDG ↔ YYZ)
  '0356:CDG': { dej: true,  din: false },
  '0357:YYZ': { dej: false, din: true  },
  '0358:CDG': { dej: false, din: true  },
  // AF 374–375 (CDG ↔ YVR)
  '0374:CDG': { dej: true,  din: false },
  '0375:YVR': { dej: true,  din: false },
  // AF 377–378 (CDG ↔ DTW)
  '0377:DTW': { dej: false, din: true  },
  '0378:CDG': { dej: false, din: true  },
  // AF 406–407 (CDG ↔ SCL)
  '0406:CDG': { dej: false, din: true  },
  '0407:SCL': { dej: true,  din: false },
  // AF 415–416 (CDG ↔ FOR)
  '0415:FOR': { dej: false, din: true  },
  '0416:CDG': { dej: true,  din: false },
  // AF 430–431 (CDG ↔ SJO)
  '0430:CDG': { dej: true,  din: false },
  '0431:SJO': { dej: false, din: true  },
  // AF 435–436 (CDG ↔ BOG)
  '0435:BOG': { dej: false, din: true  },
  '0436:CDG': { dej: false, din: true  },
  // AF 442–443 (CDG ↔ GIG)
  '0442:CDG': { dej: true,  din: false },
  '0443:GIG': { dej: false, din: true  },
  // AF 453–454, 459–460 (CDG ↔ GRU)
  '0453:GRU': { dej: true,  din: false },
  '0454:CDG': { dej: false, din: true  },
  '0459:GRU': { dej: false, din: true  },
  '0460:CDG': { dej: true,  din: false },
  // AF 465 (SSA → CDG)
  '0465:SSA': { dej: false, din: true  },
  // AF 468 (CDG → EZE)
  '0468:CDG': { dej: true,  din: false },
  // AF 470, 473 (CDG ↔ MRU)
  '0470:CDG': { dej: false, din: true  },
  '0473:MRU': { dej: true,  din: false },
  // AF 471 (EZE → CDG)
  '0471:EZE': { dej: false, din: true  },
  // AF 474–475 (CDG ↔ PTY)
  '0474:CDG': { dej: false, din: true  },
  '0475:PTY': { dej: false, din: true  },
  // AF 476 (CDG → SSA)
  '0476:CDG': { dej: true,  din: false },
  // AF 498–499 (CDG ↔ SXM)
  '0498:CDG': { dej: true,  din: false },
  '0499:SXM': { dej: false, din: true  },
  // AF 500–505 (CDG ↔ LIM)
  '0500:CDG': { dej: true,  din: false },
  '0501:LIM': { dej: false, din: true  },
  '0504:CDG': { dej: true,  din: false },
  '0505:LIM': { dej: false, din: true  },
  // AF 511–512 (CDG ↔ GIG via 350)
  '0511:GIG': { dej: false, din: true  },
  '0512:CDG': { dej: true,  din: false },
  // AF 564, 966 (tours CDG→CDG)
  '0564:CDG': { dej: true,  din: false },
  '0966:CDG': { dej: true,  din: false },
  // AF 570 (CDG → CAI)
  '0570:CDG': { dej: false, din: true  },
  // AF 592–593 (CDG ↔ CKY)
  '0592:CDG': { dej: false, din: true  },
  '0593:CKY': { dej: false, din: true  },
  // AF 643, 647, 652, 654 (CDG ↔ RUN)
  '0643:RUN': { dej: false, din: true  },
  '0647:RUN': { dej: true,  din: false },
  '0652:CDG': { dej: false, din: true  },
  '0654:CDG': { dej: true,  din: false },
  // AF 650–651 (CDG ↔ CUN)
  '0650:CDG': { dej: true,  din: false },
  '0651:CUN': { dej: false, din: true  },
  // AF 662 (CDG → DXB)
  '0662:CDG': { dej: true,  din: false },
  // AF 685 (RUH → CDG)
  '0685:RUH': { dej: true,  din: false },
  // AF 702–706 (CDG ↔ ABJ/DSS)
  '0702:CDG': { dej: true,  din: false },
  '0703:ABJ': { dej: false, din: true  },
  '0705:ABJ': { dej: false, din: true  },
  '0706:CDG': { dej: false, din: true  },
  // AF 711 (DSS → CDG)
  '0711:DSS': { dej: true,  din: false },
  // AF 718–719 (CDG ↔ DSS)
  '0718:CDG': { dej: false, din: true  },
  '0719:DSS': { dej: false, din: true  },
  // AF 722, 736, 754 (CDG ↔ BZV/FIH)
  '0722:BZV': { dej: false, din: true  },
  '0722:CDG': { dej: true,  din: false },
  '0736:BZV': { dej: false, din: true  },
  '0736:CDG': { dej: true,  din: false },
  '0754:BZV': { dej: false, din: true  },
  '0754:CDG': { dej: true,  din: false },
  // AF 740–741 (CDG ↔ CKY)
  '0740:CDG': { dej: true,  din: false },
  '0741:CKY': { dej: false, din: true  },
  // AF 758, 763, 770, 771 (CDG ↔ PTP)
  '0758:CDG': { dej: false, din: true  },
  '0763:PTP': { dej: false, din: true  },
  '0770:CDG': { dej: true,  din: false },
  '0771:PTP': { dej: false, din: true  },
  // AF 804–805 (CDG ↔ COO)
  '0804:CDG': { dej: false, din: true  },
  '0805:COO': { dej: false, din: true  },
  // AF 809, 816, 841, 842 (CDG ↔ FDF)
  '0809:FDF': { dej: false, din: true  },
  '0816:CDG': { dej: true,  din: false },
  '0841:FDF': { dej: false, din: true  },
  '0842:CDG': { dej: true,  din: false },
  // AF 828–830 (CDG ↔ NBO/LFW)
  '0828:CDG': { dej: true,  din: false },
  '0829:NBO': { dej: false, din: true  },
  '0830:CDG': { dej: true,  din: false },
  '0830:LFW': { dej: false, din: true  },
  // AF 848 (CDG ↔ DLA)
  '0848:CDG': { dej: true,  din: false },
  '0848:DLA': { dej: false, din: true  },
  // AF 860 (CDG → LFW)
  '0860:CDG': { dej: false, din: true  },
  // AF 874, 877 (CDG ↔ JRO)
  '0874:CDG': { dej: true,  din: false },
  '0874:JRO': { dej: false, din: true  },
  '0877:CDG': { dej: true,  din: false },
  '0877:JRO': { dej: false, din: true  },
  // AF 881 (CDG ↔ NSI)
  '0881:CDG': { dej: true,  din: false },
  '0881:NSI': { dej: false, din: true  },
  // AF 889–890 (CDG ↔ CAY)
  '0889:CAY': { dej: false, din: true  },
  '0890:CDG': { dej: true,  din: false },
  // AF 918 (CDG ↔ BZV/FIH)
  '0918:CDG': { dej: true,  din: false },
  '0918:BZV': { dej: false, din: true  },
  // AF 926 (CDG → LBV)
  '0926:CDG': { dej: true,  din: false },
  // AF 930, 933, 971, 972 (CDG ↔ NBJ)
  '0930:CDG': { dej: false, din: true  },
  '0933:NBJ': { dej: false, din: true  },
  '0971:NBJ': { dej: false, din: true  },
  '0972:CDG': { dej: true,  din: false },
  // AF 934–935 (CDG ↔ TNR)
  '0934:CDG': { dej: true,  din: false },
  '0935:TNR': { dej: false, din: true  },
  // AF 946–947 (CDG ↔ DLA)
  '0946:CDG': { dej: true,  din: false },
  '0947:DLA': { dej: false, din: true  },
  // AF 954–955 (CDG ↔ NSI)
  '0954:CDG': { dej: true,  din: false },
  '0955:NSI': { dej: false, din: true  },
  // AF 959, 962 (CDG ↔ HAV)
  '0959:HAV': { dej: false, din: true  },
  '0962:CDG': { dej: true,  din: false },
  // AF 977 (LBV → CDG)
  '0977:LBV': { dej: false, din: true  },
  // AF 990, 995 (CDG ↔ JNB)
  '0990:CDG': { dej: false, din: true  },
  '0995:JNB': { dej: false, din: true  },
  // Cargo AF 6720–6741 (CDG ↔ NLU/BOM/PEK/ORD)
  '6720:CDG': { dej: false, din: true  },
  '6721:NLU': { dej: true,  din: false },
  '6722:CDG': { dej: true,  din: false },
  '6723:NLU': { dej: false, din: true  },
  '6726:CDG': { dej: false, din: true  },
  '6727:BOM': { dej: true,  din: false },
  '6728:CDG': { dej: true,  din: false },
  '6729:PEK': { dej: true,  din: false },
  '6730:CDG': { dej: false, din: true  },
  '6731:ORD': { dej: true,  din: false },
  '6732:CDG': { dej: false, din: true  },
  '6733:ORD': { dej: false, din: true  },
  '6734:CDG': { dej: false, din: true  },
  '6735:ORD': { dej: true,  din: false },
  '6736:CDG': { dej: false, din: true  },
  '6737:ORD': { dej: true,  din: false },
  '6738:CDG': { dej: false, din: true  },
  '6739:ORD': { dej: true,  din: false },
  '6740:CDG': { dej: false, din: true  },
  '6741:ORD': { dej: true,  din: false },
};

export function getPlanPrestation(flightNumber: string, dep: string): FlightMealProvision | null {
  const num = String(parseInt(flightNumber, 10) || 0).padStart(4, '0');
  return PP[`${num}:${dep}`] ?? null;
}
