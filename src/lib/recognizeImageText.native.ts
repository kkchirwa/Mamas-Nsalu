import TextRecognition from '@react-native-ml-kit/text-recognition';

export async function recognizeImageText(imageUri: string): Promise<string> {
  const result = await TextRecognition.recognize(imageUri);
  return result.text;
}
