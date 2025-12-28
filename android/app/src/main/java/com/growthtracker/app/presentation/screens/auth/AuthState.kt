package com.growthtracker.app.presentation.screens.auth

import com.growthtracker.app.presentation.components.ToastData

data class AuthState(
    val isLogin: Boolean = true,
    val email: String = "",
    val username: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null,
    val isSuccess: Boolean = false,
    val toastData: ToastData? = null
)

sealed class AuthEvent {
    data object ToggleAuthMode : AuthEvent()
    data class EmailChanged(val email: String) : AuthEvent()
    data class UsernameChanged(val username: String) : AuthEvent()
    data class PasswordChanged(val password: String) : AuthEvent()
    data object Submit : AuthEvent()
    data object ClearError : AuthEvent()
    data object ClearToast : AuthEvent()
}
