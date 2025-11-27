cmake_minimum_required(VERSION 3.22.1)

project("tapstory-audio")

# Find the Oboe package
find_package(oboe REQUIRED CONFIG)

# Add the native library
add_library(
    tapstory-audio
    SHARED
    native-lib.cpp
    AudioEngine.cpp
)

# Set C++ standard
target_compile_options(tapstory-audio PRIVATE -std=c++17)

# Link libraries
target_link_libraries(
    tapstory-audio
    oboe::oboe
    android
    log
)

