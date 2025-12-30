package com.growthtracker.app.presentation.screens.dashboard

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.growthtracker.app.domain.model.ActivityType
import com.growthtracker.app.presentation.components.ActivityModal
import com.growthtracker.app.presentation.components.AppToast
import com.growthtracker.app.presentation.components.HoursSummaryCard
import com.growthtracker.app.presentation.components.SearchSheet
import com.growthtracker.app.presentation.theme.StreakGold
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    state: DashboardState,
    onEvent: (DashboardEvent) -> Unit,
    onNavigateToUserDashboard: (String) -> Unit,
    onLogout: () -> Unit,
    onBack: (() -> Unit)? = null
) {
    Box(modifier = Modifier.fillMaxSize()) {
        // Toast overlay at top
        AppToast(
            toastData = state.toastData,
            onDismiss = { onEvent(DashboardEvent.ClearToast) },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .zIndex(10f)
                .padding(top = 100.dp)
        )

        Scaffold(
            topBar = {
                CenterAlignedTopAppBar(
                    title = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.TrendingUp,
                            contentDescription = null,
                            modifier = Modifier.size(24.dp),
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Growth Tracker",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                    }
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.Default.ChevronLeft, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { onEvent(DashboardEvent.ToggleSearch) }) {
                        Icon(Icons.Default.Search, contentDescription = "Search")
                    }
                    IconButton(onClick = {
                        onEvent(DashboardEvent.Logout)
                        onLogout()
                    }) {
                        Icon(Icons.Default.Logout, contentDescription = "Logout")
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp)
            ) {
                // Read-only banner
                AnimatedVisibility(visible = state.isReadOnly) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer
                        )
                    ) {
                        Text(
                            text = "Viewing ${state.targetUsername}'s Dashboard",
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            textAlign = TextAlign.Center,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }

                // Streak Card
                StreakCard(
                    streak = state.streak,
                    isToday = state.currentDate == LocalDate.now()
                )

                Spacer(modifier = Modifier.height(8.dp))

                // Date Navigator
                DateNavigator(
                    currentDate = state.currentDate,
                    onPrevious = { onEvent(DashboardEvent.PreviousDay) },
                    onNext = { onEvent(DashboardEvent.NextDay) },
                    isNextDisabled = state.currentDate >= LocalDate.now()
                )

                // Hours Summary Card
                HoursSummaryCard(
                    totalHours = state.activities.values.sum()
                )

                Spacer(modifier = Modifier.height(8.dp))

                // Activities Grid
                if (state.isLoading && !state.isRefreshing) {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(3),
                        contentPadding = PaddingValues(bottom = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(0.dp),
                        verticalArrangement = Arrangement.spacedBy(0.dp)
                    ) {
                        items(ActivityType.entries) { activity ->
                            ActivityTile(
                                activity = activity,
                                hours = state.activities[activity] ?: 0f,
                                onClick = { onEvent(DashboardEvent.ActivityClicked(activity)) },
                                isClickable = !state.isReadOnly && state.currentDate <= LocalDate.now()
                            )
                        }
                    }
                }
            }
        }
        } // End Box
    }

    // Activity Modal
    if (state.isModalOpen && state.selectedActivity != null) {
        ActivityModal(
            activity = state.selectedActivity,
            hours = state.modalHours,
            onHoursChange = { onEvent(DashboardEvent.ModalHoursChanged(it)) },
            onSave = { onEvent(DashboardEvent.SaveActivity) },
            onDismiss = { onEvent(DashboardEvent.CloseModal) },
            error = state.modalError,
            isSaving = state.isSaving
        )
    }

    // Search Sheet
    if (state.isSearchOpen) {
        SearchSheet(
            query = state.searchQuery,
            onQueryChange = { onEvent(DashboardEvent.SearchQueryChanged(it)) },
            results = state.searchResults,
            isSearching = state.isSearching,
            onUserClick = { user ->
                onEvent(DashboardEvent.ToggleSearch)
                onNavigateToUserDashboard(user.username)
            },
            onDismiss = { onEvent(DashboardEvent.ToggleSearch) }
        )
    }
}

@Composable
private fun StreakCard(
    streak: com.growthtracker.app.domain.model.Streak,
    isToday: Boolean
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .border(
                width = 1.dp,
                color = StreakGold,
                shape = RoundedCornerShape(12.dp)
            ),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (isToday) {
                // Soft Icon Container for Fire
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(StreakGold.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.LocalFireDepartment,
                        contentDescription = null,
                        tint = StreakGold,
                        modifier = Modifier.size(18.dp)
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Current Streak: ${streak.current}",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.width(16.dp))
                Text(
                    text = "|",
                    color = MaterialTheme.colorScheme.outline
                )
                Spacer(modifier = Modifier.width(16.dp))
            }
            Text(
                text = "Longest Streak: ${streak.longest}",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun DateNavigator(
    currentDate: LocalDate,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    isNextDisabled: Boolean
) {
    val formatter = DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy", Locale.ENGLISH)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onPrevious) {
                Icon(Icons.Default.ChevronLeft, contentDescription = "Previous day")
            }

            Text(
                text = currentDate.format(formatter).uppercase(),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f)
            )

            IconButton(
                onClick = onNext,
                enabled = !isNextDisabled
            ) {
                Icon(
                    Icons.Default.ChevronRight,
                    contentDescription = "Next day",
                    tint = if (isNextDisabled) {
                        MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    }
                )
            }
        }
    }
}

@Composable
private fun ActivityTile(
    activity: ActivityType,
    hours: Float,
    onClick: () -> Unit,
    isClickable: Boolean
) {
    val isActive = hours > 0
    val backgroundColor = if (isActive) {
        activity.color.copy(alpha = 0.08f)
    } else {
        Color.Transparent
    }

    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .border(
                width = 0.5.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
            )
            .background(backgroundColor)
            .clip(RoundedCornerShape(0.dp))
            .clickable(enabled = isClickable, onClick = onClick)
            .padding(8.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Soft Icon Container
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .background(
                        if (isActive) activity.color.copy(alpha = 0.12f)
                        else MaterialTheme.colorScheme.outline.copy(alpha = 0.15f)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = activity.icon,
                    contentDescription = activity.displayName,
                    modifier = Modifier.size(24.dp),
                    tint = if (isActive) activity.color else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(6.dp))

            Text(
                text = activity.displayName,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = if (isActive) activity.color else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 10.sp
            )

            Spacer(modifier = Modifier.height(2.dp))

            Text(
                text = "${hours}h",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                color = if (isActive) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
