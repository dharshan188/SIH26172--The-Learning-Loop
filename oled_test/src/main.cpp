#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

constexpr uint8_t kOledAddress = 0x3C;
U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200);
  Serial.println("OLED_TEST_START controller=SH1106");
  Wire.begin(21, 22);
  Wire.setClock(400000);
  oled.setI2CAddress(kOledAddress << 1);
  oled.begin();
  oled.clearBuffer();
  oled.setFont(u8g2_font_logisoso24_tr);
  constexpr char text[] = "HELLO";
  const int16_t x = (128 - oled.getStrWidth(text)) / 2;
  oled.drawStr(x, 43, text);
  oled.sendBuffer();
  Serial.println("OLED_TEST_DRAWN text=HELLO");
}

void loop() {}
