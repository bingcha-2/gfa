package main

import "testing"

// Test runs must never launch or terminate the user's real desktop applications.
func appActionsSuppressed() bool { return testing.Testing() }
