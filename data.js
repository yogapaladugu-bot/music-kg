/*
 * This file is the original, hand-written demo dataset used by the browser UI.
 * It is intentionally separate from the enormous MusicBrainz dump files.
 *
 * A graph has two ingredients:
 *   1. nodes: the things we know about (here, music genres), and
 *   2. edges: the relationships between those things (here, influences).
 *
 * `const` means the variable cannot be reassigned to a different array.
 * The array itself may still be read and changed. Each `{ ... }` inside it is
 * one JavaScript object whose named fields become node data in vis-network.
 */
const OGnodes = 
    [
// POPULAR MUSIC GENRES
 {"id":1,"label":"Pop","title":"A constantly evolving genre built around accessibility, memorable melodies, and cultural trends.","description":"Pop music absorbs elements from many different genres, including rock, electronic, hip-hop, and R&B. Because it adapts to changing sounds and technology, it often acts as a bridge connecting different musical worlds.","year":"Emerged in the 1950s","artists":"Taylor Swift, Olivia Rodrigo, Sabrina Carpenter, Stray Kids, Katseye, Ariana Grande", "shape":"circle"},

{"id":2,"label":"Rock","title":"A genre centered around amplified instruments, powerful performances, and cultural expression.","description":"Rock developed from blues, country, and rhythm-based American music traditions. Its emphasis on electric guitar, drums, and experimentation influenced genres such as metal, punk, alternative rock, and progressive rock.","year":"Emerged in the 1950s","artists":"The Beatles, The Rolling Stones, Queen, Led Zeppelin, Nirvana, Foo Fighters", "shape":"circle"},

{"id":3,"label":"Hip-Hop","title":"A genre built around rhythm, sampling, lyrical expression, and creative storytelling.","description":"Hip-Hop developed through DJing, MCing, and beat-making, becoming a major form of musical and cultural expression. It has influenced and blended with genres like R&B, electronic music, jazz, and pop.","year":"Emerged in the 1970s","artists":"Tupac Shakur, The Notorious B.I.G., Jay-Z, Eminem, Kendrick Lamar", "shape":"circle"},

{"id":4,"label":"Electronic","title":"Music created through technology, synthesizers, digital production, and experimental sound design.","description":"Electronic music uses instruments, software, and production techniques to create new sounds and rhythms. It connects genres like house, techno, ambient, dubstep, and synth pop while influencing modern pop music.","year":"Emerged in the 1970s","artists":"Daft Punk, The Chemical Brothers, Deadmau5, Skrillex", "shape":"circle"},

{"id":5,"label":"Jazz","title":"A genre known for improvisation, complex rhythms, and musical experimentation.","description":"Jazz developed from African American musical traditions, combining blues, ragtime, and improvisational techniques. Its influence can be heard in genres including soul, hip-hop, R&B, and experimental music.","year":"Emerged around 1895 to 1912","artists":"Louis Armstrong, Duke Ellington, Miles Davis, John Coltrane", "shape":"circle"},

{"id":6,"label":"Classical","title":"A broad musical tradition focused on composition, structure, harmony, and orchestration.","description":"Classical music developed through centuries of Western musical traditions and influenced concepts of melody, harmony, and composition. Its ideas continue to appear in film scores, experimental music, and modern arrangements.","year":"First originated around 500-1400 CE but the 'Classical era' was the period between 1750 and 1820","artists":"Beethoven, Mozart, Bach, Vivaldi", "shape":"circle"},

{"id":7,"label":"Country","title":"A genre rooted in storytelling, acoustic instruments, and American folk traditions.","description":"Country developed from Appalachian folk music, blues, and other regional traditions. Its focus on storytelling and instrumentation influenced genres such as country rock, folk, and Americana.","year":"Emerged in the early 1920s","artists":"Johnny Cash, Dolly Parton, George Strait, Luke Bryan", "shape":"circle"},

    {"id":9,"label":"Indie Pop","title":"","description":"A style of pop music associated with independent artists and labels. It often combines catchy melodies with unconventional production, personal songwriting, and influences from alternative music.","year":"Emerged in the late 1970s, early 1980s","artists":"The Killers, Arcade Fire, Passion Pit, Tame Impala"},

{"id":10,"label":"Synth Pop","title":"","description":"A pop genre that relies heavily on synthesizers, electronic sounds, and programmed rhythms. It became especially popular during the 1980s and helped shape modern electronic pop.","year":"Emerged in the 1980s","artists":"Depeche Mode, New Order, Gary Numan, The Cure"},

{"id":11,"label":"Hyperpop","title":"","description":"A modern experimental style that exaggerates elements of pop, electronic music, and hip-hop through distorted sounds, extreme production, and unpredictable structures.","year":"Emerged in the early-to-mid 2010s","artists":"100 gecs, Charli XCX, SOPHIE, Princess Nokia"},

{"id":12,"label":"Dream Pop","title":"","description":"A subgenre known for atmospheric textures, layered sounds, and dreamy vocals. It often creates immersive moods through effects like reverb and distortion.","year":"Emerged in the 1980s","artists":"The Cure, My Bloody Valentine, Slowdive, Cocteau Twins"},

{"id":13,"label":"Alternative Rock","title":"","description":"A broad rock category that developed as artists experimented beyond mainstream rock structures. It often includes unique songwriting, unconventional sounds, and diverse influences.","year":"Emerged in the 1980s","artists":"Nirvana, Radiohead, Pearl Jam, R.E.M."},

{"id":14,"label":"Punk Rock","title":"","description":"A fast, energetic style of rock known for simple structures, rebellious themes, and a DIY approach to music creation.","year":"Emerged in the 1970s","artists":"The Clash, Sex Pistols, Green Day, Fall Out Boy"},

{"id":15,"label":"Metal","title":"","description":"A heavier form of rock characterized by powerful guitar riffs, intense vocals, and dramatic musical styles. It later developed into many specialized subgenres.","year":"Emerged in the late 1960s and early 1970s","artists":"Black Sabbath, Metallica, Iron Maiden, Slayer"},

{"id":16,"label":"Shoegaze","title":"","description":"A rock genre focused on dense layers of sound, heavy effects, and atmospheric guitar textures. Its music often emphasizes mood and sound over traditional song structures.","year":"Emerged in the late 1980s-early 1990s","artists":"My Bloody Valentine, Slowdive, Ride, Chapterhouse"},

{"id":17,"label":"Progressive Rock","title":"","description":"A style of rock that experiments with complex compositions, unusual time signatures, extended songs, and influences from classical and jazz music.","year":"Emerged in the 1960s","artists":"Pink Floyd, Yes, Genesis, King Crimson"},

{"id":18,"label":"Trap","title":"","description":"A hip-hop style recognized for heavy bass, electronic drums, and rhythmic vocal patterns. It developed from Southern hip-hop and became one of the most influential modern rap styles.","year":"Emerged in the 2000s","artists":"Future, Migos, Lil Uzi Vert, Travis Scott"},

{"id":19,"label":"Drill","title":"","description":"A darker style of hip-hop known for aggressive rhythms, minimal production, and direct storytelling. It developed in regional scenes before spreading globally.","year":"Emerged in the 2010s","artists":"Lil Durk, Chief Keef, King Von, Lil Herb"},

{"id":20,"label":"Boom Bap","title":"","description":"A classic hip-hop style centered around hard-hitting drum patterns, sampled beats, and lyrical focus. It became strongly associated with the golden age of rap.","year":"Emerged in the 1980s and experienced its 'Golden Age' during the early 1990s","artists":"A Tribe Called Quest, De La Soul, Guru's Jazzmatazz, The Roots"},
{
    "id":21,"label":"Alternative Hip-Hop","title":"","description":"A branch of hip-hop that experiments with unconventional production, diverse musical influences, and creative lyrical themes. It often blends elements of jazz, electronic, rock, soul, and spoken word while moving beyond traditional rap styles.","year":"Emerged in the late 1980s and early 1990s","artists":"A Tribe Called Quest, Outkast, MF DOOM, Tyler, the Creator"
},

{
    "id":22, "label":"Cloud Rap","title":"", "description":"A hip-hop subgenre known for atmospheric production, dreamy synthesizers, heavy reverb, and laid-back vocal delivery. It combines modern trap influences with ambient textures to create a hazy, emotional sound.","year":"Emerged in the late 2000s","artists":"Lil B, Yung Lean, Bladee, A$AP Rocky"
},
{"id":23,"label":"House","title":"","description":"An electronic dance genre built around repetitive rhythms, four-on-the-floor beats, and synthesized sounds. It originated in club culture and became a foundation of dance music.","year":"Emerged in the 1980s","artists":"Carl Cox, Richie Hawtin, Deadmau5, Skrillex"},

{"id":24,"label":"Techno","title":"","description":"An electronic genre focused on futuristic sounds, mechanical rhythms, and repetitive structures. It developed around underground dance scenes and electronic experimentation.","year":"Emerged in the 1980s","artists":"Juan Atkins, Derrick May, Kevin Saunderson, The Chemical Brothers"},

{"id":25,"label":"Dubstep","title":"","description":"An electronic genre known for deep bass, dramatic drops, and syncopated rhythms. It gained mainstream attention through energetic and heavily produced tracks.","year":"Emerged in the 2000s","artists":"Skrillex, Nero, DJ Shadow, Burial"},

{"id":26,"label":"Ambient","title":"","description":"A genre focused on atmosphere, texture, and creating immersive sound environments rather than traditional song structures.","year":"Emerged in the 1970s","artists":"Brian Eno, Aphex Twin, Boards of Canada, Karlheinz Stockhausen"},

    {"id":27,"label":"Drum and Bass","title":"","description":"An electronic genre built around fast breakbeats, heavy basslines, and energetic rhythms. It developed from UK dance music scenes.","year":"Emerged in the 1990s","artists":"Goldie, Roni Size, LTJ Bukem, Shy FX"},
  {"id":28,"label":"Soul","title":"A genre combining emotional vocals, gospel influences, and rhythm-driven instrumentation.","description":"Soul emerged from the combination of gospel, blues, and rhythm and blues. Its powerful vocals and expressive style shaped later genres including funk, R&B, pop, and hip-hop.","year":"Emerged in the 1950s","artists":"Aretha Franklin, Otis Redding, Sam Cooke, Ray Charles"},

{"id":29,"label":"Funk","title":"","description":"A rhythm-focused genre built around strong basslines, syncopated grooves, and energetic performances. Funk became a major influence on disco, hip-hop, and modern dance music.","year":"Emerged in the 1960s","artists":"James Brown, Parliament-Funkadelic, The Meters, Larry Graham"},

{"id":30,"label":"Neo Soul","title":"","description":"A modern interpretation of soul music that combines classic soul influences with elements of jazz, R&B, hip-hop, and electronic production.","year":"Emerged in the 1990s","artists":"D'Angelo, Erykah Badu, J Dilla, Common"},

{"id":31,"label":"Contemporary R&B","title":"","description":"A modern form of R&B that blends soulful vocals with influences from pop, hip-hop, and electronic music. It often focuses on polished production and vocal performance.","year":"Emerged in the 1990s","artists":"Mariah Carey, Boyz II Men, TLC, Janet Jackson"},

{"id":32,"label":"Bebop","title":"","description":"A jazz style known for fast tempos, complex melodies, and advanced improvisation. It shifted jazz toward a more musician-focused and experimental approach.","year":"Emerged in the 1940s","artists":"Charlie Parker, Dizzy Gillespie, Thelonious Monk, Bud Powell"},

{"id":33,"label":"Fusion Jazz","title":"","description":"A style that combines jazz improvisation with elements of rock, funk, and electronic music. It expanded jazz by incorporating new instruments and production techniques.","year":"Emerged in the 1970s","artists":"Miles Davis, Chick Corea, Herbie Hancock, John McLaughlin"},

{"id":34,"label":"Smooth Jazz","title":"","description":"A softer jazz style focused on accessible melodies, polished production, and relaxed grooves. It became popular through radio and contemporary instrumental music.","year":"Emerged in the 1980s","artists":"David Sanborn, Kenny G, George Benson, Bob James"},

{"id":35,"label":"Baroque","title":"","description":"A classical era known for dramatic expression, complex compositions, and detailed ornamentation. It introduced many important developments in Western musical structure.","year":"Emerged in the 1600s and flourished across Europe until the 1750s","artists":"Johann Sebastian Bach, George Frideric Handel, Antonio Vivaldi"},

{"id":36,"label":"Romantic Classical","title":"","description":"A classical period focused on emotional expression, larger compositions, and expanded orchestral possibilities. Music from this era often emphasized drama and individual creativity.","year":"Emerged in the 1800s","artists":"Frédéric Chopin, Franz Liszt, Pyotr Ilyich Tchaikovsky"},

{"id":37,"label":"Minimalism","title":"","description":"A style based on repetition, gradual changes, and simple musical patterns. It influenced modern classical, electronic, and experimental music.","year":"Emerged in the 1960s","artists":"Steve Reich, Philip Glass, John Adams"},

{"id":38,"label":"Traditional Country","title":"","description":"An early form of country music focused on storytelling, acoustic instruments, and influences from folk, blues, and rural traditions.","year":"Emerged in the 1920s-1940s","artists":"Hank Williams, Patsy Cline, Johnny Cash"},

{"id":39,"label":"Country Rock","title":"","description":"A fusion genre combining country instrumentation and storytelling with the energy and structure of rock music.","year":"Emerged in the 1960s","artists":"Waylon Jennings, Willie Nelson, Merle Haggard"},

{"id":40,"label":"Bluegrass","title":"","description":"A fast-paced acoustic style featuring instruments like banjo, fiddle, and mandolin. It developed from Appalachian musical traditions.","year":"Emerged in the 1940s","artists":"Bill Monroe, Earl Scruggs, Chet Atkins"},

{"id":41,"label":"Reggae","title":"","description":"A Jamaican genre built around rhythmic basslines, offbeat guitar patterns, and socially conscious themes. It became influential worldwide through its cultural impact.","year":"Emerged in the 1960s","artists":"Bob Marley, Jimmy Cliff, Peter Tosh"},

{"id":42,"label":"Afrobeats","title":"","description":"A modern African music style combining traditional rhythms with influences from pop, dance music, and global sounds.","year":"Emerged in the 2000s","artists":"Burna Boy, Wizkid, Davido"},

{"id":43,"label":"Latin Pop","title":"","description":"A pop style incorporating Latin rhythms, languages, and musical traditions. It combines regional influences with mainstream pop production.","year":"Emerged in the 1980s","artists":"Enrique Iglesias, Ricky Martin, Jennifer Lopez"},

{"id":44,"label":"K-Pop","title":"","description":"A South Korean pop industry combining genres such as pop, hip-hop, electronic music, and R&B with highly produced performances.","year":"Emerged in the 2000s","artists":"BTS, BLACKPINK, TWICE"},

{"id":45,"label":"J-Pop","title":"","description":"Japanese popular music that combines influences from Western pop, electronic music, and local Japanese musical traditions.","year":"Emerged in the 1990s","artists":"Hikaru Utada, Arashi, Perfume, Kyary Pamyu Pamyu"},

{"id":46,"label":"Psychedelic Rock","title":"","description":"A rock style known for experimental sounds, unusual effects, and attempts to create immersive listening experiences.","year":"Emerged in the 1960s","artists":"The Beatles, The Doors, Jimi Hendrix"},

{"id":47,"label":"Folk","title":"Traditional music centered around storytelling, cultural identity, and community expression.","description":"Folk music represents musical traditions passed through communities over generations. It influenced country, blues, rock, and singer-songwriter styles.","year":"Originated in the 19th century but had no single starting point as it has basically been around since humans formed communities","artists":"Bob Dylan, Joan Baez, Peter Paul and Mary","shape":"circle"},

{"id":48,"label":"Blues","title":"A foundational genre recognized for emotional expression and expressive musical techniques.","description":"Blues developed from African American musical traditions and became one of the foundations of modern popular music. It influenced rock, jazz, soul, R&B, and country.","year":"Emerged in the late 1800s, early 1900s","artists":"Muddy Waters, B.B. King, Howlin' Wolf", "shape":"circle"},

{"id":49,"label":"Gospel","title":"A vocal-centered tradition shaped by spirituality, community, and powerful performances.","description":"Gospel developed from African American religious music traditions and influenced modern vocal styles, especially soul, R&B, and blues.","year":"Emerged in the late 1800s, early 1900s","artists":"Mahalia Jackson, Thomas A. Dorsey, Choirs", "shape":"circle"},

{"id":50,"label":"Experimental Music","title":"Music that challenges traditional structures through unusual sounds and techniques.","description":"Experimental music explores new approaches to composition, technology, and sound. It connects classical ideas with electronic, ambient, and avant-garde movements.","year":"Emerged in the early 1900s","artists":"John Cage, Karlheinz Stockhausen, Pierre Boulez", "shape":"circle"},
]


/*
 * These are the hand-curated relationships between the genre nodes above.
 * `from` and `to` contain node IDs, not array positions. `value` controls the
 * displayed line weight, `arrows: "to"` makes direction visible, and `title`
 * is the explanation shown for the relationship. The short comments at the
 * end of each row make the numeric IDs readable while debugging.
 */
const OGedges = 
  [
  {from:48, to:2, value:5, arrows:"to", "title": "Blues provided the foundation for chords in rock music"}, // Blues - Rock
  {from:48, to:5, value:5, arrows:"to", "title": "Introduced Blue Notes, bent notes that sound very emotional, to jazz"}, // Blues - Jazz
  {from:48, to:28, value:4, arrows:"to", "title": "Blues provided soul's foundational structure, rhythm, and raw emotion."}, // Blues - Soul
  {from:48, to:7, value:3, arrows:"to", "title": "Blues provided the instrumental and vocal techniques and the foundational song structure of country music"}, // Blues - Country
  {from:48, to:49, value:3, "title": "Gospel adopted the blues scale, emotional delivery, and guitar styles."}, // Blues - Gospel
  {from:47, to:7, value:4, arrows:"to", "title": "Folk provided country's traditional ballads, acoustic instrumentation, and storytelling."}, // Folk - Country

  // JAZZ CONNECTIONS
  {from:5, to:32, value:5, arrows:"to", "title": "Branching off jazz, bebop modernized jazz with faster tempos, complex chords, and improvisation."}, // Jazz - Bebop
  {from:5, to:33, value:4, arrows:"to", "title": "Jazz-fusion modernized traditional jazz by adding electric instruments and rock grooves"}, // Jazz - Fusion Jazz
  {from:5, to:34, value:3, arrows:"to", "title": "Smooth jazz simplified jazz improvisation, adding polished, pop-oriented R&B production for easy listening."}, // Jazz - Smooth Jazz
  {from:5, to:21, value:3, "title": "Alternative hip-hop incorporates jazz harmonies and live instrumentation."}, // Jazz - Alternative Hip-Hop
  {from:5, to:30, value:3, arrows:"to", "title": "Neo soul infuses traditional soul music with complex jazz harmonies, extended chords, and smoky textures."}, // Jazz - Neo Soul

  // ROCK NETWORK
  {from:2, to:13, value:5, arrows:"to", "title": "Alternative rock rejected mainstream stadium rock, prioritizing raw guitar distortion and indie DIY ethics."}, // Rock - Alternative Rock
  {from:2, to:14, value:5, arrows:"to", "title": "Punk rock stripped rock down to its fastest speeds, simple three-chord progressions, and political aggression."}, // Rock - Punk Rock
  {from:2, to:15, value:5, "title": "Heavy metal amplified rock blues roots into high-volume distortion, driving power chords, and aggressive drumming."}, // Rock - Metal
  {from:2, to:46, value:4, arrows:"to", "title": "Psychedelic rock expanded classic rock with studio echo effects, tape loops, and mind-altering soundscapes."}, // Rock - Psychedelic Rock
  {from:2, to:47, value:3, "title": "Folk rock combined traditional acoustic folk songwriting with the driving electric rhythm section of rock."}, // Rock - Folk
  {from:2, to:39, value:3, "title": "Country rock blended electric guitar riffs and rock energy with country's twang and storytelling."}, // Rock - Country Rock
  {from:2, to:17, value:4, arrows:"to", "title": "Progressive rock merged rock energy with classical structures, symphonic arrangements, and odd time signatures."}, // Rock - Progressive Rock
  {from:14, to:15, value:4, arrows:"to", "title": "Punk rock's breakneck speed and raw aggression produced faster metal sub-genres like thrash metal."}, // Punk - Metal

  // METAL/PUNK/ALTERNATIVE
  {from:15, to:14, value:4, "title": "Metal guitar precision and punk's chaotic energy cross-pollinated to create genres like crossover thrash."}, // Metal - Punk
  {from:15, to:17, value:4, "title": "Progressive metal fuses virtuosic, complex time signatures of prog-rock with heavy metal's aggressive distortion."}, // Metal - Progressive
  {from:13, to:16, value:5, arrows: "to", "title": "Shoegaze grew from alternative rock, burying vocals under layers of swirling, ambient guitar effects."}, // Alternative Rock - Shoegaze
  {from:13, to:17, value:3, "title": "Alternative rock bands adopted progressive rock's shifting structures to create dynamic, math-rock arrangements."}, // Alternative - Progressive
  {from:46, to:16, value:4, "title": "Psychedelic rock's heavy reverb and hypnotic studio loops laid the atmospheric blueprint for shoegaze textures."}, // Psychedelic - Shoegaze

  // POP WORLD
  {from:1, to:9, value:5, arrows:"to", "title": "Indie pop channels mainstream pop melodic catchiness but retains a quirky, low-fidelity independent production style."}, // Pop - Indie Pop
  {from:1, to:10, value:5, arrows:"to", "title": "Synth pop replaced organic instruments with synthesizers, driving 1980s pop music onto dance floors."}, // Pop - Synth Pop
  {from:1, to:44, value:4, arrows:"to", "title": "K-Pop adapted Western pop's bright hooks and high-energy choreography into a highly polished industry model."}, // Pop - K-Pop
  {from:1, to:45, value:4, arrows:"to", "title": "J-Pop evovled from pop music, blendig elements of pop music with traditional Japanese musical styles."}, // Pop - J-Pop
  {from:1, to:31, value:5, "title": "Contemporary R&B merges slick, commercial pop vocal production with deep electronic bass beats and trap rhythms."}, // Pop - Contemporary R&B
  {from:1, to:4, value:4, "title": "Electronic pop infuses classic verse-chorus pop vocal structures with computerized synths and quantized drum beats."}, // Pop - Electronic
  {from:1, to:43, value:4, arrows:"to", "title": "Latin pop blends mainstream global pop hooks with traditional reggaeton, salsa, and cumbia rhythmic patterns."}, // Pop - Latin Pop
  {from:1, to:42, value:3, "title": "Contemporary pop frequently borrows the syncopated percussion patterns and polyrhythms from West African afrobeats."}, // Pop - Afrobeats

  // ELECTRONIC NETWORK
  {from:4, to:23, value:5, arrows:"to", "title": "House music pioneered electronic dance by looping a hypnotic four-on-the-floor bass drum kick pattern."}, // Electronic - House
  {from:4, to:24, value:5, arrows:"to", "title": "Techno mechanized electronic music using repetitive, industrial synthesizer loops and high-tempo drum machine tracks."}, // Electronic - Techno
  {from:4, to:25, value:4, arrows:"to", "title": "Dubstep revolutionized electronic bass music with half-time drum rhythms and distorted, wobbling low-end frequencies."}, // Electronic - Dubstep
  {from:4, to:26, value:5, arrows:"to", "title": "Ambient music stripped away electronic drum beats, focusing entirely on atmospheric textures and evolving soundscapes."}, // Electronic - Ambient
  {from:4, to:27, value:4, arrows:"to", "title": "Drum and bass accelerated electronic beats to extreme speeds, layering frantic breakbeats over heavy basslines."}, // Electronic - Drum and Bass
  {from:4, to:10, value:4, arrows:"to", "title": "Electronic dance music technologies directly influenced synth pop's reliance on hardware sequencers and drum machines."}, // Electronic - Synth Pop
  {from:4, to:11, value:5, "title": "Hyperpop pushes electronic music to its absolute extremes with maxed-out compression, pitch shifts, and chaotic synths."}, // Electronic - Hyperpop

  // HIP-HOP NETWORK
  {from:3, to:18, value:5, arrows:"to", "title": "Trap music defined a new hip-hop era with rolling hi-hats, heavy Roland TR-808 sub-bass, and dark synth brass."}, // Hip-Hop - Trap
  {from:3, to:19, value:4, arrows:"to", "title": "Drill music hardened hip-hop with skipping snare placements, sliding basslines, and gritty, localized street storytelling."}, // Hip-Hop - Drill
  {from:3, to:20, value:5, arrows:"to", "title": "Boom bap anchored golden-era hip-hop with crisp acoustic snare cracks and jazzy vinyl sample loops."}, // Hip-Hop - Boom Bap
  {from:3, to:21, value:4, "title": "Alternative hip-hop broke genre boundaries by swapping standard party raps for abstract lyricism and eccentric samples."}, // Hip-Hop - Alternative Hip-Hop
  {from:3, to:22, value:4, arrows:"to", "title": "Cloud rap slowed hip-hop down, floating lo-fi vocals over ethereal, hazy, and dreamy ambient production loops."}, // Hip-Hop - Cloud Rap
  {from:3, to:31, value:5, "title": "Hip-hop production styles completely reinvented R&B by replacing acoustic grooves with heavy programmed drum loops."}, // Hip-Hop - R&B
  {from:3, to:29, value:3, "title": "Hip-hop built its foundational sampling culture directly on the classic breakbeats and drum grooves of funk music."}, // Hip-Hop - Funk
  {from:20, to:21, value:4, arrows:"to", "title": "Boom bap's reliance on soulful, dusty vinyl loops paved the way for alternative hip-hop's eclectic production style."}, // Boom Bap - Alternative Hip-Hop

  // SOUL/R&B/FUNK
  {from:28, to:29, value:5, arrows:"to", "title": "Funk stripped down soul melodies to focus intensely on syncopated basslines and playing 'on the one' beat."}, // Soul - Funk
  {from:28, to:31, value:5, arrows:"to", "title": "Contemporary R&B smoothed out traditional soul's gritty vocal delivery with digital studio polishing and modern synths."}, // Soul - Contemporary R&B
  {from:28, to:30, value:4, "title": "Neo soul resurrected classic, live-instrumentation soul music, adding jazzier chords and hip-hop poetic sensibilities."}, // Soul - Neo Soul
  {from:29, to:33, value:3, "title": "Funk's slapping basslines and driving rhythms collided with jazz soloing to create high-energy jazz fusion."}, // Funk - Jazz Fusion
  {from:30, to:31, value:5, arrows:"to", "title": "Neo soul pushed contemporary R&B to embrace raw vocal vulnerability and vintage electric piano textures."}, // Neo Soul - R&B

  // COUNTRY/FOLK
  {from:7, to:38, value:5, "title": "Country music's modern variants evolved directly from traditional country's acoustic guitars, fiddles, and honky-tonk themes."}, // Country - Traditional Country
  {from:7, to:40, value:4, "title": "Bluegrass branched off country by accelerating tempos and utilizing unamplified banjo, fiddle, and mandolin picking."}, // Country - Bluegrass
  {from:7, to:47, value:5, "title": "Country music shares a fluid, overlapping border with folk, both trading acoustic picking patterns and working-class stories."}, // Country - Folk
  {from:38, to:39, value:4, "title": "Traditional country vocals and pedal steel licks were injected with rock drums to create country rock."}, // Traditional Country - Country Rock

  // CLASSICAL/EXPERIMENTAL
  {from:6, to:35, value:5, arrows:"to", "title": "Classical music traces its formal structural discipline back to baroque counterpoint and intricate harpsichord fugues."}, // Classical - Baroque
  {from:6, to:36, value:5, "title": "The Romantic era expanded classical music with massive orchestras, intense emotional expression, and dramatic storytelling."}, // Classical - Romantic
  {from:6, to:37, value:4, arrows:"to", "title": "Minimalism rebelled against complex classical arrangements, focusing on stripped-down, hypnotic, and repeating musical motifs."}, // Classical - Minimalism
  {from:6, to:50, value:3, "title": "Experimental music abandoned traditional classical notation and scales, utilizing avant-garde noise and found-sound textures."}, // Classical - Experimental
  {from:37, to:26, value:4, arrows:"to", "title": "Minimalism's slowly shifting loops and sustained tones directly inspired ambient music's percussionless textures."}, // Minimalism - Ambient
  {from:50, to:11, value:3, "title": "Experimental avant-garde sonic textures were repackaged with pop hooks to birth the glitched-out soundscapes of hyperpop."}, // Experimental - Hyperpop

  // CROSSOVER BRIDGES
  {from:41, to:42, value:4, "title": "Reggae's skanking guitar rhythms and heavy offbeat basslines migrated to Africa, deeply shaping afrobeats production."}, // Reggae - Afrobeats
  {from:42, to:44, value:3, "title": "Afrobeats polyrhythms and vocal syncopation have increasingly been adopted by modern K-Pop production teams for global hits."}, // Afrobeats - K-Pop
  {from:43, to:44, value:3, "title": "Latin pop's reggaeton drum loops and acoustic guitar hooks are frequently blended into K-Pop tracks for cross-market appeal."}, // Latin Pop - K-Pop
  {from:49, to:28, value:5, "title": "Gospel music's spiritual call-and-response and raw vocal power served as the core musical engine for early soul."}, // Gospel - Soul
  {from:47, to:38, value:4, "title": "Folk music's centuries-old British and Celtic ballads provided the direct lyrical blueprints for traditional country music."}, // Folk - Country
  {from:12, to:16, value:5, "title": "Dream pop's ethereal synth layers and floating vocals easily bled into shoegaze's wall-of-sound guitar textures."}, // Dream Pop - Shoegaze
  {from:9, to:12, value:4, "title": "Indie pop's bright melodies were slowed down and soaked in heavy studio reverb to create the atmosphere of dream pop."}, // Indie Pop - Dream Pop
  {from:10, to:11, value:5, arrows:"to", "title": "Synth pop's retro 1980s synthesizer leads were digitized, sped up, and heavily distorted to construct hyperpop."}, // Synth Pop - Hyperpop
  {from:11, to:22, value:4, "title": "Hyperpop's metallic, pitch-shifted production style merged with cloud rap's druggy, slowed-down vocal delivery."} // Hyperpop - Cloud Rap
]
