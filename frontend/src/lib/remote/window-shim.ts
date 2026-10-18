export function getCurrentWindow() {
  return {
    setTitle: async (title: string) => {
      document.title = title;
    },
  };
}
