const OFFSET_FORM = /^[+-]/u;

export const canonicalZone = (zone: string | undefined): string | undefined => {
  if (zone === undefined) {
    return undefined;
  }

  try {
    const { timeZone } = new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions();

    return OFFSET_FORM.test(timeZone) ? undefined : timeZone;
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }

    throw error;
  }
};
