// Agent media must be full bleed. User-uploaded media is not silently cropped.
export function assertStoryPublicationFormat(mediaType: string, metadata?: Record<string,string>) {
  if (mediaType === "Historia" && metadata?.generatedBy === "social-studio-ai"
    && (metadata.storyFormat ?? metadata.storyformat) !== "9x16-v4") {
    throw new Error("Historia pendiente de adaptación 9:16 sin barras. No se enviará el archivo antiguo; revisa el calendario.");
  }
}
