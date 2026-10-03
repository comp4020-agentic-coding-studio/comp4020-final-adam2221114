# Crit 8 Reflection

## 1. What was the breakthrough that moved the work forward?

The biggest breakthrough was realizing that “technically working” was not the same as “feeling right.” Early movement was correct according to the server state, but it still felt like a slideshow because the player only moved between server snapshots. That pushed me to treat playtesting as evidence, not just automated tests. We changed the client from simple interpolation to local prediction with server reconciliation, which made the controls feel immediate without giving up server authority.

The same pattern happened again with the wall and turret. The wall first existed only visually, so it looked like a defence but did not actually change the game. The turret also seemed broken, but checking the authoritative zombie HP showed that the damage logic was already correct; the real problem was missing visual feedback. These corrections moved the project forward because they came from checking what the player actually experienced and then tracing that experience back to the real system state.

## 2. What did this work change about who I want to be as a software developer?

This week changed how I want to use AI as a development partner. I do not want to accept a feature just because the code passes tests or the agent says it is complete. I want to be the person who defines the intended behaviour, plays the result, questions anything that feels wrong, and verifies the underlying state before changing code.

I also want to become more disciplined about scope. The project improved most when I gave Claude narrow constraints and corrected specific problems, rather than asking for large feature additions.