export const loadHeadedDocument = (): never => {
  throw Object.assign(new Error("The headed mode is not implemented."), {
    code: "MODE_NOT_IMPLEMENTED",
  });
};

export const loadHeadlessDocument = (): never => {
  throw Object.assign(new Error("The headless mode is not implemented."), {
    code: "MODE_NOT_IMPLEMENTED",
  });
};
