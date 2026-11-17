import { v7 } from 'uuid';

/** UUID v7: time-ordered, can also be generated offline by devices. Use for every record. */
export const newId = (): string => v7();
