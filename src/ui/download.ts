/** Hands a file made in the browser to the user. Nothing is sent anywhere. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the address dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
