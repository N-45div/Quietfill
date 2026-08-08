export const VERSION = "0.1.0";

export const OP_TYPE_QUIETFILL = "QUIETFILL";
// Extension-prefixed on purpose: generic command words can collide with FCC
// system commands and silently never relay (observed on Coston2).
export const OP_COMMAND_PRIVATE_BID = "QF_PRIVATE_BID";
export const OP_COMMAND_CLEAR = "QF_CLEAR";
