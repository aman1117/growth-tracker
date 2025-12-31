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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.EmojiEvents
import androidx.compose.material.icons.outlined.LocalFireDepartment
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.growthtracker.app.domain.model.ActivityType
import com.growthtracker.app.presentation.components.ActivityModal
import com.growthtracker.app.presentation.components.AppToast
import com.growthtracker.app.presentation.components.SearchSheet
import com.growthtracker.app.presentation.components.ThemeToggle
import com.growthtracker.app.presentation.theme.GrowthTrackerTheme
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
                            // Logo container like frontend
                            Box(
                                modifier = Modifier
                                    .size(28.dp)
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(GrowthTrackerTheme.colors.logoBg),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.TrendingUp,
                                    contentDescription = null,
                                    modifier = Modifier.size(20.dp),
                                    tint = GrowthTrackerTheme.colors.logoColor
                                )
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "Growth Tracker",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = (-0.025).sp
                            )
                        }
                    },
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.Outlined.ChevronLeft, contentDescription = "Back")
                            }
                        }
                    },
                    actions = {
                        ThemeToggle()
                        Spacer(modifier = Modifier.width(12.dp))
                        // Search button - circular with subtle border
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                                .clickable { onEvent(DashboardEvent.ToggleSearch) },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.Outlined.Search,
                                contentDescription = "Search",
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        // Avatar
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .background(GrowthTrackerTheme.colors.avatarBg),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = (state.targetUsername?.firstOrNull() ?: 'U').uppercase(),
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        // Logout button - circular with subtle border
                        Box(
                            modifier = Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                                .clickable {
                                    onEvent(DashboardEvent.Logout)
                                    onLogout()
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.AutoMirrored.Outlined.Logout,
                                contentDescription = "Logout",
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        Spacer(modifier = Modifier.width(16.dp))
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                        containerColor = GrowthTrackerTheme.colors.headerBg
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
                                containerColor = MaterialTheme.colorScheme.surface
                            ),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text(
                                text = "Viewing ${state.targetUsername}'s Dashboard",
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                                textAlign = TextAlign.Center,
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.SemiBold
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    // Combined DaySummaryCard (like frontend)
                    DaySummaryCard(
                        currentDate = state.currentDate,
                        onPrevious = { onEvent(DashboardEvent.PreviousDay) },
                        onNext = { onEvent(DashboardEvent.NextDay) },
                        isNextDisabled = state.currentDate >= LocalDate.now(),
                        totalHours = state.activities.values.sum(),
                        streak = state.streak,
                        isToday = state.currentDate == LocalDate.now()
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    // Activities Grid
                    if (state.isLoading && !state.isRefreshing) {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator(
                                color = GrowthTrackerTheme.colors.accent
                            )
                        }
                    } else {
                        LazyVerticalGrid(
                            columns = GridCells.Fixed(3),
                            contentPadding = PaddingValues(bottom = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(0.dp),
                            verticalArrangement = Arrangement.spacedBy(0.dp),
                            modifier = Modifier
                                .border(1.dp, MaterialTheme.colorScheme.outline)
                                .background(MaterialTheme.colorScheme.surface)
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
        } // End Scaffold
    } // End Box

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

/**
 * Combined DaySummaryCard - Matches React frontend's DaySummaryCard component
 * Contains: Date Navigator + Hours Progress + Streaks in one unified card
 */
@Composable
private fun DaySummaryCard(
    currentDate: LocalDate,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    isNextDisabled: Boolean,
    totalHours: Float,
    streak: com.growthtracker.app.domain.model.Streak,
    isToday: Boolean
) {
    val maxHours = 24f
    val percentage = (totalHours / maxHours).coerceIn(0f, 1f)
    val remainingHours = (maxHours - totalHours).coerceAtLeast(0f)
    val isComplete = totalHours >= maxHours
    
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        shape = RoundedCornerShape(12.dp)
    ) {
        Column {
            // Top Section: Date Navigator
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(
                    onClick = onPrevious,
                    modifier = Modifier.size(40.dp)
                ) {
                    Icon(
                        Icons.Outlined.ChevronLeft,
                        contentDescription = "Previous day",
                        modifier = Modifier.size(22.dp)
                    )
                }

                Text(
                    text = formatDateDisplay(currentDate),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.02.sp,
                    textAlign = TextAlign.Center
                )

                IconButton(
                    onClick = onNext,
                    enabled = !isNextDisabled,
                    modifier = Modifier.size(40.dp)
                ) {
                    Icon(
                        Icons.Outlined.ChevronRight,
                        contentDescription = "Next day",
                        modifier = Modifier.size(22.dp),
                        tint = if (isNextDisabled) {
                            MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        }
                    )
                }
            }
            
            // Divider
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.outline)
            )

            // Middle Section: Hours Progress
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 16.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = if (isComplete) Icons.Outlined.CheckCircle else Icons.Outlined.Schedule,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = if (isComplete) GrowthTrackerTheme.colors.success else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = if (isComplete) "Day Complete!" else "${formatHours(remainingHours)}h remaining",
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = if (isComplete) GrowthTrackerTheme.colors.success else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(
                            text = formatHours(totalHours),
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.alignByBaseline()
                        )
                        Text(
                            text = "/${maxHours.toInt()}h",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.alignByBaseline()
                        )
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Progress Bar
                LinearProgressIndicator(
                    progress = { percentage },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(8.dp)
                        .clip(RoundedCornerShape(4.dp)),
                    color = if (isComplete) GrowthTrackerTheme.colors.success else GrowthTrackerTheme.colors.accent,
                    trackColor = GrowthTrackerTheme.colors.progressTrack,
                    strokeCap = StrokeCap.Round
                )
            }

            // Divider
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.outline)
            )

            // Bottom Section: Streaks
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(GrowthTrackerTheme.colors.iconBgMuted)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (isToday) {
                    // Current Streak
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(GrowthTrackerTheme.colors.streakGold.copy(alpha = 0.15f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.LocalFireDepartment,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = GrowthTrackerTheme.colors.streakGold
                            )
                        }
                        Text(
                            text = "${streak.current}",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            text = "day streak",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    // Divider
                    Box(
                        modifier = Modifier
                            .padding(horizontal = 16.dp)
                            .width(1.dp)
                            .height(16.dp)
                            .background(MaterialTheme.colorScheme.outline)
                    )
                }

                // Best Streak
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(GrowthTrackerTheme.colors.accent.copy(alpha = 0.15f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.EmojiEvents,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = GrowthTrackerTheme.colors.accent
                        )
                    }
                    Text(
                        text = "${streak.longest}",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Text(
                        text = "best streak",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private fun formatDateDisplay(date: LocalDate): String {
    val today = LocalDate.now()
    val yesterday = today.minusDays(1)
    
    return when (date) {
        today -> "Today"
        yesterday -> "Yesterday"
        else -> {
            val formatter = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH)
            date.format(formatter)
        }
    }
}

private fun formatHours(hours: Float): String {
    return if (hours % 1f == 0f) {
        hours.toInt().toString()
    } else {
        String.format(Locale.US, "%.1f", hours)
    }
}

/**
 * ActivityTile - Matches React frontend's ActivityTile component
 * Sharp corners, duotone icons, activity-colored highlights
 */
@Composable
private fun ActivityTile(
    activity: ActivityType,
    hours: Float,
    onClick: () -> Unit,
    isClickable: Boolean
) {
    val isActive = hours > 0
    val backgroundColor = if (isActive) {
        activity.color.copy(alpha = 0.06f)
    } else {
        Color.Transparent
    }

    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline
            )
            .background(backgroundColor)
            .clickable(enabled = isClickable, onClick = onClick)
            .padding(8.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Duotone Icon Container - like frontend
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .clip(CircleShape)
                    .background(
                        if (isActive) activity.color.copy(alpha = 0.20f)
                        else GrowthTrackerTheme.colors.iconBgMuted
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = activity.icon,
                    contentDescription = activity.displayName,
                    modifier = Modifier.size(26.dp),
                    tint = if (isActive) activity.color else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Activity name
            Text(
                text = activity.displayName,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = if (isActive) activity.color else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 11.sp,
                lineHeight = 14.sp
            )

            Spacer(modifier = Modifier.height(4.dp))

            // Hours
            Text(
                text = "${formatHours(hours)}h",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = if (isActive) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
