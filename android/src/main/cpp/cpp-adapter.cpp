#include <jni.h>
#include <fbjni/fbjni.h>
#include "L2capOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::l2cap::registerAllNatives();
  });
}