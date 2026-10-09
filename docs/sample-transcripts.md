# Sample transcripts

Fictional calls to the fictional **Cavern Electrical** after-hours line. Names, addresses and numbers are made up; phone numbers use the reserved 555-01xx range. The full webhook payloads are in [`examples/calls/`](../examples/calls/), and `npm run demo` replays them.

| Call | What the classifier decides | Why |
|---|---|---|
| [Burning smell at the panel](#01) | emergency | Burning smell, smoke or fire ("burning smell") |
| [No heat on a freezing night](#02) | emergency | No heat in freezing weather ("heat stopped + 6 degrees") |
| [Dead kitchen outlets](#03) | routine | No emergency signs in what the caller said. |
| [Breaker keeps tripping](#04) | urgent | Power out ("lost power"); Breaker keeps tripping ("keeps tripping") |
| [Basement flooding near the panel](#05) | emergency | Flooding or water near electrical ("flooding") |

(Decided by the rules plus the voice agent's own urgency field, with the LLM off. With the LLM on, the level can only go up, never down.)

<a id="01"></a>
## 01. Burning smell at the panel (emergency, Vapi format)

File: [`examples/calls/01-burning-smell-panel.vapi.json`](../examples/calls/01-burning-smell-panel.vapi.json)

> **Assistant:** Thanks for calling Cavern Electrical. You've reached our after-hours line. I'm an automated assistant and this call is recorded so the team can follow up. What's going on tonight?  
> **Caller:** Hi, yeah, there's a burning smell coming from our breaker panel in the garage. It's kind of a hot plastic smell.  
> **Assistant:** Thanks for telling me. If you see smoke or flames, please leave the house and call 911 first. Is anyone in danger right now?  
> **Caller:** No smoke that I can see, but the panel door feels warm and the smell is getting stronger.  
> **Assistant:** Okay. Please don't touch the panel. Can I get your name?  
> **Caller:** Maria Okafor.  
> **Assistant:** Thanks, Maria. What's the best number to reach you?  
> **Caller:** 612-555-0142.  
> **Assistant:** And the address?  
> **Caller:** 418 Larkspur Lane, Ridgeview.  
> **Assistant:** Got it. I'm flagging this as an emergency for the on-call electrician, and someone will call you back as soon as possible. If it gets worse, call 911.  
> **Caller:** Okay, thank you.  

<a id="02"></a>
## 02. No heat on a freezing night (agent said urgent, rules raise it to emergency)

File: [`examples/calls/02-no-heat-freezing.vapi.json`](../examples/calls/02-no-heat-freezing.vapi.json)

> **Assistant:** Thanks for calling Cavern Electrical. You've reached our after-hours line. I'm an automated assistant and this call is recorded so the team can follow up. What's going on tonight?  
> **Caller:** Our heat stopped working. We have electric baseboard heat and none of it is coming on.  
> **Assistant:** I'm sorry, that's no fun at night. Is the power on in the rest of the house?  
> **Caller:** Yes, lights work. But it's 6 degrees outside and it's already 58 in here, and we have a newborn.  
> **Assistant:** Understood, I'll mark this as a priority. Can I have your name and a callback number?  
> **Caller:** Tom Reyes, 612-555-0167.  
> **Assistant:** Thanks, Tom. And where are you located?  
> **Caller:** It's 77 Juniper Court, unit B.  
> **Assistant:** Thank you. I'm passing this to the on-call electrician now. In the meantime, keep doors closed and use safe, listed space heaters only if you have them.  
> **Caller:** Okay. Please hurry.  

<a id="03"></a>
## 03. Dead kitchen outlets (routine, generic format, negations)

File: [`examples/calls/03-kitchen-outlets.generic.json`](../examples/calls/03-kitchen-outlets.generic.json)

> **Assistant:** Thanks for calling Cavern Electrical. You've reached our after-hours line. I'm an automated assistant and this call is recorded so the team can follow up. What's going on tonight?  
> **Caller:** Hi. Two outlets on my kitchen counter stopped working this evening. I pressed the reset button on the GFCI but nothing happened.  
> **Assistant:** Thanks. Do you notice any burning smell, sparks or heat at the outlets?  
> **Caller:** No sparks, no burning smell, nothing like that. It's not urgent, Monday is fine.  
> **Assistant:** Great. Can I get your name, number and address?  
> **Caller:** Priya Lindqvist, 612-555-0181, 2090 Alder Street.  
> **Assistant:** Thanks, Priya. The office will call you Monday morning to set up a time.  
> **Caller:** Perfect, any time after 9 works.  

<a id="04"></a>
## 04. Breaker keeps tripping (urgent, LLM down in the demo)

File: [`examples/calls/04-breaker-tripping.vapi.json`](../examples/calls/04-breaker-tripping.vapi.json)

> **Assistant:** Thanks for calling Cavern Electrical. You've reached our after-hours line. I'm an automated assistant and this call is recorded so the team can follow up. What's going on tonight?  
> **Caller:** Half of the house lost power about an hour ago and the breaker keeps tripping when I reset it.  
> **Assistant:** Okay. Any burning smell, sparks, or anything hot to the touch?  
> **Caller:** No, nothing like that. The furnace is on the other side, so we still have heat.  
> **Assistant:** Good. Can I get your name and best number?  
> **Caller:** Gus Hartley. 612-555-0123.  
> **Assistant:** And your address, Gus?  
> **Caller:** 5 Wren Hollow Road.  
> **Assistant:** Thanks. Please leave that breaker off for now. I'll have the team call you first thing in the morning.  
> **Caller:** Sounds good, as early as possible please.  

<a id="05"></a>
## 05. Basement flooding near the panel (emergency, no structured data from the agent)

File: [`examples/calls/05-basement-flooding.vapi.json`](../examples/calls/05-basement-flooding.vapi.json)

> **Assistant:** Thanks for calling Cavern Electrical. You've reached our after-hours line. I'm an automated assistant and this call is recorded so the team can follow up. What's going on tonight?  
> **Caller:** Hi, my basement is flooding from the snow melt and the water is getting close to the electrical panel.  
> **Assistant:** Please don't go into the water or touch the panel. If you can't stay safe, leave the house and call 911. Is anyone in the basement now?  
> **Caller:** No, we're all upstairs.  
> **Assistant:** Good. What's your name?  
> **Caller:** Lena Brandt.  
> **Assistant:** And a number where the electrician can reach you?  
> **Caller:** This number is fine. 612-555-0159.  
> **Assistant:** What's the address?  
> **Caller:** It's 31 Quarry Ridge Drive.  
> **Assistant:** Thank you, Lena. I've marked this as an emergency and the on-call electrician will call you right back.  
