/**
 * A second round of `target` phrasings (same format as `target.ts`), written after the first
 * evaluations so most elements have more than one way of being asked for. Each was checked against
 * the training lexicon before it went in (`leak-check.ts`): a phrasing any training run had already
 * seen, or nearly, was dropped, so no checkpoint trained before this round is flattered by it.
 */
export const TARGET_MORE: Record<string, Record<string, string[]>> = {
  "home": {
    "Safari": ["look something up online"],
    "Messages": ["reply to a text"],
    "Photos": ["see yesterday's snapshots"],
    "Wallet": ["show my loyalty card at checkout"],
    "News": ["catch up on current events"],
    "Siri": ["talk to the assistant"],
  },
  "settings-root-top": {
    "General": ["reset the network settings"],
    "Accessibility": ["zoom the whole display for low vision"],
    "Camera": ["shoot ProRAW photos"],
    "StandBy": ["clock face while charging on its side"],
    "Screen Time": ["downtime for my teenager"],
    "Privacy & Security": ["which apps can use my microphone"],
  },
  "settings-root-3": {
    "Game Center": ["multiplayer invites from friends"],
    "iCloud": ["how much cloud storage I have left"],
  },
  "settings-accessibility-2": {
    "VoiceOver, Off": ["have every button read to me"],
    "Display & Text Size": ["grayscale screen"],
    "Motion": ["stop the wallpaper moving"],
    "Subtitles & Captioning": ["caption style for videos"],
  },
  "settings-appearance": {
    "9:41, Dark": ["easier on my eyes at night"],
    "Bold Text": ["make every font heavier"],
    "Reduce Motion": ["calmer transitions"],
  },
  "settings-camera": {
    "Formats": ["most compatible photo format"],
    "Grid": ["composition overlay lines"],
    "Mirror Front Camera": ["selfies saved the way I see them"],
  },
  "settings-general": {
    "About": ["the IMEI"],
    "Keyboard": ["stop the auto capitalizing"],
    "Fonts": ["fonts I added"],
  },
  "settings-keyboard": {
    "Text Replacement": ["expand abbreviations as I type"],
    "Predictive Text": ["hide the suggestion bar"],
    "Haptic Feedback": ["buzz when I press a key"],
  },
  "settings-language": {
    "Temperature, °F": ["switch weather units to metric degrees"],
    "Measurement System, US": ["centimeters and kilograms"],
    "Region, United States": ["I moved to the UK"],
  },
  "settings-privacy-1": {
    "Location Services, 1 while using": ["stop apps tracking where I go"],
    "Contacts, None": ["apps that read my phone book"],
  },
  "settings-privacy-2": {
    "Microphone, 0": ["apps that record audio"],
    "Local Network, 0": ["apps talking to my smart speakers on the LAN"],
  },
  "settings-privacy-3": {
    "Safety Check": ["an ex can still see where I am"],
    "Analytics & Improvements": ["stop sharing usage data with Apple"],
  },
  "settings-screentime": {
    "Screen Time Schedule, Available device hours": ["lock the phone after 9pm"],
  },
  "settings-safari-1": {
    "Search Engine, Google": ["use Ecosia for searches"],
  },
  "settings-safari-2": {
    "Extensions": ["add a password manager extension to the browser"],
  },
  "settings-safari-3": {
    "Fraudulent Website Warning": ["warn me before I open a fake bank site"],
  },
  "settings-safari-4": {
    "Clear History and Website Data": ["forget every site I've visited"],
    "Advanced": ["web developer tools"],
  },
  "settings-siri": {
    "Voice, American (Voice 4)": ["an Australian accent for the assistant"],
    "ChatGPT": ["let the assistant ask an AI chatbot"],
  },
  "safari-pagemenu": {
    "Find on Page": ["where does this article mention the price"],
    "Request Desktop Website": ["the site I'd see on a laptop"],
    "Hide Toolbar": ["hide the address bar while reading"],
  },
  "safari-tabs": {
    "Private, Tab Group": ["browse without leaving traces"],
  },
  "safari-newtab": {
    "History": ["that page I looked at this morning"],
    "Reading List": ["articles I set aside"],
  },
  "maps-root": {
    "clear, 67 degrees, Air Quality, 51, Moderate": ["is it smoggy today"],
    "Map Modes": ["aerial view of the city"],
    "Look Around": ["see the storefronts from the street"],
    "Home, Add": ["mark where I live"],
    "Work, Add": ["set my commute destination"],
    "San Francisco Museum of Modern Art": ["the modern art museum"],
    "Grace Cathedral": ["the Episcopal cathedral"],
    "Embarcadero": ["the bayfront promenade"],
    "Union Square": ["the square with the big shopping stores"],
  },
  "maps-search": {
    "Gas Stations": ["I need fuel"],
    "Hikes": ["a nature walk nearby"],
    "~Ippudo": ["a Japanese noodle bar"],
    "~Morella": ["South American steak"],
  },
  "maps-coffee": {
    "~Breakfast Spots": ["a place for eggs and pancakes"],
  },
  "maps-place": {
    "Menu": ["what do they sell"],
    "2 min, walking": ["walk me there"],
    "Report an Issue": ["this place has moved"],
    "Share": ["send this cafe to someone"],
    "Ratings & Reviews": ["is it any good"],
  },
  "maps-directions": {
    "Ride": ["book a Lyft"],
    "Cycle": ["ride my bicycle there"],
    "Transit": ["take the subway"],
    "Drive": ["the car route"],
    "Steps": ["list every turn"],
  },
  "maps-modes": {
    "Satellite": ["photos from above"],
    "Driving": ["traffic view"],
    "Transit": ["train lines on the map"],
  },
  "maps-satellite": {
    "Traffic": ["show where the roads are jammed"],
  },
  "maps-permission": {
    "Don’t Allow": ["refuse location access"],
  },
  "calendar-root": {
    "Wednesday, September 30": ["the day after today"],
    "Inbox": ["meeting requests people sent"],
    "Add": ["put a dentist visit on my calendar"],
  },
  "calendar-month": {
    "Monday, September 7": ["the September federal holiday"],
    "Thursday, October 1": ["October 1st"],
  },
  "calendar-new-event": {
    "Alert, None": ["a notification before it starts"],
    "Location or Video Call": ["add the address"],
  },
  "contacts-card": {
    "Message": ["send John a text"],
    "Video": ["video chat with John"],
    "mobile, (888) 555-5512": ["his cellphone"],
    "~work, 3494 Kuhl Avenue": ["where he works"],
  },
  "contacts-anna": {
    "birthday, August 29, 1985": ["how old she is"],
    "Video": ["see Anna on a video call"],
  },
  "contacts-list": {
    "Add": ["save someone's number"],
    "~Hank M. Zakroff": ["the person from the finance company"],
  },
  "contacts-edit": {
    "Add photo": ["put her picture on the card"],
    "add phone": ["her work number too"],
  },
  "contacts-edit-2": {
    "Add to Emergency Contacts": ["who to call if something happens to me"],
    "Delete Contact": ["erase her card entirely"],
    "link contacts…": ["combine two cards for the same person"],
    "add social profile": ["her LinkedIn"],
  },
  "messages-add": {
    "Apple Cash": ["pay them"],
    "Audio": ["a spoken message"],
    "#images": ["an animated reaction"],
  },
  "photos-photo": {
    "Info": ["the camera settings used"],
    "Delete": ["get rid of this shot"],
    "Edit": ["brighten this picture"],
  },
  "photos-edit": {
    "Filters": ["sepia tone"],
    "Rotate": ["it's upside down"],
  },
  "photos-collections": {
    "Recently Deleted": ["bring back a photo I removed"],
    "Videos": ["only my movies"],
    "Create": ["make an album for the trip"],
  },
  "files-more": {
    "New Folder": ["make a directory for receipts"],
    "Scan Documents": ["photograph a contract into a PDF"],
    "Connect to Server": ["reach my NAS"],
    "Name, Ascending": ["A to Z"],
    "Date": ["most recent first"],
    "Size": ["largest first"],
    "List": ["a detailed list view"],
  },
  "files-browse": {
    "Recents": ["the last files I touched"],
  },
  "reminders-new": {
    "Location": ["alert me when I leave the office"],
    "Flag": ["star this task"],
    "Details": ["priority and tags"],
  },
  "reminders-more": {
    "Show List Info": ["change this list's color"],
    "Print": ["print the list"],
  },
  "reminders-lists": {
    "Completed": ["finished to-dos"],
    "New Reminder": ["jot down a task"],
  },
  "shortcuts-library": {
    "Automation": ["run a shortcut when I get home"],
    "Gallery": ["example shortcuts to add"],
  },
  "shortcuts-gallery": {
    "Add, Start Pomodoro": ["a 25-minute work timer"],
  },
  "health-browse": {
    "Activity": ["how active I was this week"],
    "Body Measurements": ["my weight trend"],
    "Cycle Tracking": ["track my menstrual cycle"],
    "Hearing": ["noise exposure"],
    "Medications": ["my prescriptions"],
    "Mental Wellbeing": ["how I've been feeling emotionally"],
    "Mobility": ["my gait"],
    "Nutrition": ["what I ate today"],
    "Respiratory": ["my blood oxygen"],
    "Sleep": ["my bedtime schedule"],
    "Symptoms": ["record a cough"],
  },
  "health-heart": {
    "AFib History": ["how often I'm in AFib"],
    "Blood Pressure": ["systolic and diastolic readings"],
    "Cardio Fitness": ["my aerobic fitness level"],
    "Electrocardiograms (ECG)": ["the heart rhythm recordings from my watch"],
    "Heart Rate Variability": ["beat-to-beat variation"],
  },
  "health-summary": {
    "Profile": ["my health details and medical ID"],
    "Steps, No Data": ["my step count today"],
  },
  "health-sharing": {
    "Share with your doctor": ["let my clinic see my records"],
    "Research Studies": ["take part in medical research"],
  },
  "health-setup-2": {
    "Height": ["my height in inches"],
    "Last Name": ["family name"],
  },
  "wallet-root": {
    "Add Card": ["put my bank card in the phone"],
    "Orders": ["where is my delivery"],
  },
  "passwords-root": {
    "Codes, 0 Items": ["verification codes for two-step login"],
    "Security, 0 Items": ["reused or compromised passwords"],
    "Deleted, 0 Items": ["logins I removed recently"],
    "New Password": ["add a login for a website"],
    "Wi-Fi, 3 Items": ["network passwords"],
  },
  "passwords-wifi": {
    "Café Wi-Fi, WPA3 Personal": ["the coffee place's wireless"],
    "Work Wi-Fi, WPA3 Personal": ["the network at my job"],
  },
  "news-root": {
    "Sports": ["last night's game results"],
    "Puzzles": ["word games"],
    "Entertainment": ["movie and TV news"],
    "Local": ["what's happening in my town"],
  },
  "news-puzzles": {
    "Sudoku": ["the numbers grid game"],
    "Leaderboard": ["top scores"],
  },
  "fitness-root": {
    "Workout": ["record a walk"],
    "Sharing": ["see my friends' activity"],
    "Fitness+": ["yoga videos with a trainer"],
  },
  "fitness-workouts": {
    "Heart Rate Devices": ["connect a Polar strap"],
    "GymKit": ["link with a gym elliptical"],
  },
  "watch-root": {
    "Start Pairing": ["set up my new watch"],
  },
  "watch-faces": {
    "Nike Collection, Celebrating sport and activity.": ["the running shoe company's designs"],
    "Astronomy, Inspired by planetary bodies.": ["the solar system face"],
    "Analog Time, Designs with distinct watch hands.": ["a classic face with hands"],
  },
  "remote-root": {
    "Mute": ["turn the sound off on the TV"],
    "Play Pause": ["pause the movie"],
  },
  "preview-root": {
    "Scan Documents": ["turn a paper page into a PDF"],
    "New Document": ["an empty file"],
  },
};
